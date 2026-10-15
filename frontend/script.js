// ======================================================
// Global Variables
// ======================================================

const page = document.body.dataset.page;
const JWT_STORAGE_KEY = "jwt";

// ======================================================
// Common Utility Functions
// ======================================================

function getAuthToken() {
    return sessionStorage.getItem(JWT_STORAGE_KEY);
}

function clearAuthToken() {
    sessionStorage.removeItem(JWT_STORAGE_KEY);
}

function decodeJwtPayload(token) {
    try {
        const base64Url = token.split(".")[1];
        const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
        const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
        return JSON.parse(atob(padded));
    } catch (err) {
        return null;
    }
}

function isTokenExpired(token) {
    const payload = decodeJwtPayload(token);
    if (!payload || !payload.exp) return true;
    return Date.now() >= payload.exp * 1000;
}

function wasPageRefreshed() {
    const [entry] = performance.getEntriesByType("navigation");
    return Boolean(entry && entry.type === "reload");
}

// Wraps fetch() to attach the admin JWT (when present) and to
// automatically log the admin out if the server reports the
// token is missing/invalid/expired.
async function authFetch(url, options = {}) {
    const token = getAuthToken();
    const headers = new Headers(options.headers || {});
    if (token) headers.set("Authorization", `Bearer ${token}`);

    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) {
        clearAuthToken();
        window.location.reload();
        throw new Error("Session expired. Please log in again.");
    }
    return response;
}

function setMessage(element, message, type = "") {
    if (!element) return;
    element.textContent = message;
    element.className = "inline-message";
    if (type) {
        element.classList.add(type);
    }
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function safeFileName(value) {
    return String(value)
        .trim()
        .replace(/[^A-Za-z0-9_-]+/g, "_")
        .replace(/^_+|_+$/g, "") || "student";
}

function buildStudentQrUrl(student) {
    return `/qr/${encodeURIComponent(student.token)}`;
}

function setButtonLoading(button, isLoading, loadingLabel = "Loading...") {
    if (!button) return;

    const label = button.querySelector(".button-label");
    if (label) {
        if (!button.dataset.defaultLabel) {
            button.dataset.defaultLabel = label.textContent;
        }
        label.textContent = isLoading ? loadingLabel : button.dataset.defaultLabel;
    }

    button.disabled = isLoading;
    button.classList.toggle("is-loading", isLoading);
}

async function parseJsonResponse(response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const detail = data.detail || "Something went wrong. Please try again.";
        throw new Error(detail);
    }
    return data;
}

function formatDate(value) {
    if (!value) return "-";

    const normalizedValue =
        typeof value === "string" && !/(Z|[+\-]\d{2}:\d{2})$/.test(value)
            ? `${value}Z`
            : value;

    const localDate = new Date(normalizedValue);
    if (Number.isNaN(localDate.getTime())) {
        return String(value);
    }

    return localDate.toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    });
}

// ======================================================
// UI Helpers
// ======================================================

function playToneSequence(sequence) {
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;

        const audioContext = new AudioContextClass();
        let currentTime = audioContext.currentTime;

        sequence.forEach(({ frequency, duration, type = "sine", gap = 0.05 }) => {
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            oscillator.type = type;
            oscillator.frequency.value = frequency;
            gainNode.gain.setValueAtTime(0.0001, currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.085, currentTime + 0.01);
            gainNode.gain.exponentialRampToValueAtTime(0.0001, currentTime + duration);

            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);

            oscillator.start(currentTime);
            oscillator.stop(currentTime + duration);
            currentTime += duration + gap;
        });

        window.setTimeout(() => {
            audioContext.close().catch(() => {});
        }, Math.max((currentTime - audioContext.currentTime + 0.1) * 1000, 150));
    } catch (error) {
        console.debug("Audio feedback unavailable.", error);
    }
}

function vibratePattern(pattern) {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        navigator.vibrate(pattern);
    }
}

function playScannerFeedback(status) {
    if (appConfig && appConfig.scanner_sound === false && appConfig.scanner_vibration === false) return;
    const soundEnabled = !appConfig || appConfig.scanner_sound !== false;
    const vibrationEnabled = !appConfig || appConfig.scanner_vibration !== false;
    if (status === "VALID") {
        if (soundEnabled) playToneSequence([{ frequency: 880, duration: 0.1, gap: 0.02 }]);
        if (vibrationEnabled) vibratePattern(80);
        return;
    }

    if (status === "USED") {
        if (soundEnabled) playToneSequence([
            { frequency: 540, duration: 0.1, gap: 0.03 },
            { frequency: 420, duration: 0.12, gap: 0.02 },
        ]);
        if (vibrationEnabled) vibratePattern(180);
        return;
    }

    if (soundEnabled) playToneSequence([
        { frequency: 240, duration: 0.12, type: "square", gap: 0.03 },
        { frequency: 180, duration: 0.24, type: "square", gap: 0.02 },
    ]);
    if (vibrationEnabled) vibratePattern(320);
}

// Powers the "Lock Page" button on the Settings page (and any other
// page that includes a [data-lock-session] control).
function enableSessionLockButtons() {
    document.querySelectorAll("[data-lock-session]").forEach((button) => {
        button.addEventListener("click", () => {
            clearAuthToken();
            window.location.reload();
        });
    });
}

// Shows the "Continue your session?" modal after a detected page
// refresh while a still-valid JWT exists. Reuses the existing
// auth-overlay / auth-card / glass-panel / primary-button /
// secondary-button styling so no new CSS or redesign is needed.
function showSessionContinueModal({ onContinue, onLogout }) {
    document.getElementById("sessionContinueOverlay")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "sessionContinueOverlay";
    overlay.className = "auth-overlay";
    overlay.style.display = "grid";
    overlay.innerHTML = `
        <div class="auth-card">
            <img src="/static/logo.png" alt="">
            <h2>Welcome back</h2>
            <p>Your session is still active.</p>
            <div class="auth-form">
                <button type="button" id="sessionContinueButton" class="btn btn--primary btn--block">Continue</button>
                <button type="button" id="sessionLogoutButton" class="btn btn--block">Log out</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById("sessionContinueButton").addEventListener("click", () => {
        overlay.remove();
        onContinue();
    });
    document.getElementById("sessionLogoutButton").addEventListener("click", () => {
        overlay.remove();
        onLogout();
    });
}

function protectPage(onAuthorized) {
    const overlay = document.getElementById("loginOverlay");
    const form = document.getElementById("authForm");
    const passwordInput = document.getElementById("authPassword");
    const error = document.getElementById("authError");
    const mainContent = document.getElementById("mainContent");
    const submitButton = form?.querySelector('button[type="submit"]');
    let initialized = false;

    function showMainContent() {
        document.body.classList.add("auth-ready");
        if (mainContent) {
            mainContent.style.display = "block";
            mainContent.setAttribute("aria-hidden", "false");
        }
        if (overlay) {
            overlay.style.display = "none";
            overlay.hidden = true;
        }
        if (!initialized) {
            initialized = true;
            onAuthorized();
        }
    }

    function showLoginOverlay() {
        document.body.classList.remove("auth-ready");
        if (mainContent) {
            mainContent.style.display = "none";
            mainContent.setAttribute("aria-hidden", "true");
        }
        if (overlay) {
            overlay.hidden = false;
            overlay.style.display = "grid";
        }
        window.setTimeout(() => passwordInput?.focus(), 120);
    }

    if (!overlay || !form || !passwordInput || !mainContent) {
        showMainContent();
        return;
    }

    const existingToken = getAuthToken();

    if (existingToken && !isTokenExpired(existingToken)) {
        if (wasPageRefreshed()) {
            showSessionContinueModal({
                onContinue: showMainContent,
                onLogout: () => {
                    clearAuthToken();
                    showLoginOverlay();
                },
            });
        } else {
            showMainContent();
        }
    } else {
        clearAuthToken();
        showLoginOverlay();
    }

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (error) error.textContent = "";
        if (submitButton) submitButton.disabled = true;

        try {
            const response = await fetch("/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password: passwordInput.value }),
            });

            if (!response.ok) {
                throw new Error("Incorrect Password");
            }

            const data = await response.json();
            sessionStorage.setItem(JWT_STORAGE_KEY, data.access_token);
            passwordInput.value = "";
            showMainContent();
        } catch (err) {
            clearAuthToken();
            if (error) error.textContent = "Incorrect Password";
            passwordInput.select();
        } finally {
            if (submitButton) submitButton.disabled = false;
        }
    });
}

// ======================================================
// Registration Page
// ======================================================

let appConfig = null;

async function loadPublicConfig() {
    try {
        const response = await fetch("/public-config", { cache: "no-store" });
        if (response.ok) appConfig = await response.json();
    } catch (error) {
        console.warn("Could not load event settings; using page defaults.", error);
    }
    applyAppConfig();
}

function applyAppConfig() {
    if (!appConfig) return;
    const cfg = appConfig;
    document.documentElement.style.setProperty("--brand", cfg.brand_color || "#0b6fb8");
    document.documentElement.style.setProperty("--brand-hover", cfg.brand_color || "#0b6fb8");
    document.documentElement.style.setProperty("--brand-tint", `${cfg.brand_color || "#0b6fb8"}20`);
    if (cfg.theme) applyTheme(cfg.theme);
    document.querySelectorAll(".brand").forEach((brand) => {
        const img = brand.querySelector("img");
        if (img && cfg.logo_url) img.src = cfg.logo_url;
        const textNode = [...brand.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
        if (textNode) textNode.textContent = ` ${cfg.event_name || "Entry Desk"}`;
    });
    document.querySelectorAll(".ticket-head img, .auth-card > img").forEach((img) => {
        if (cfg.logo_url) img.src = cfg.logo_url;
    });
    document.querySelectorAll(".ticket-head strong").forEach((node) => node.textContent = cfg.event_name || "Event");
    document.querySelectorAll(".ticket-head span").forEach((node) => node.textContent = cfg.organization_name || "");
    if (page === "registration") {
        const heading = document.querySelector(".page-head h1");
        const description = document.querySelector(".page-head p");
        if (heading) heading.textContent = cfg.event_name || "Register a participant";
        if (description) {
            const eventMeta = [cfg.event_date, cfg.event_location].filter(Boolean).join(" · ");
            description.textContent = [cfg.event_description || "Register to receive a QR entry pass.", eventMeta].filter(Boolean).join(" · ");
        }
        const course = document.querySelector('select[name="course"]');
        if (course && Array.isArray(cfg.course_options)) {
            const selected = course.value;
            course.innerHTML = '<option value="" disabled>Select course / category</option>' + cfg.course_options.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
            course.value = cfg.course_options.includes(selected) ? selected : "";
        }
        renderCustomRegistrationFields(cfg.custom_fields || []);
        const form = document.getElementById("registrationForm");
        if (form && cfg.registration_open === false) {
            form.querySelectorAll("input, select, button").forEach((el) => el.disabled = true);
            const message = document.getElementById("registrationMessage");
            if (message) setMessage(message, "Registration is currently closed.", "error");
        }
    }
    if (page === "scanner") {
        const heading = document.querySelector(".page-head h1");
        const description = document.querySelector(".page-head p");
        if (heading) heading.textContent = `${cfg.event_name || "Event"} — QR scanner`;
        if (description) description.textContent = "Point the camera at a participant's QR pass to verify entry.";
    }
    document.title = `${cfg.event_name || "Entry Desk"} · ${page === "settings" ? "Settings" : page === "scanner" ? "Scanner" : page === "admin" ? "Dashboard" : "Registration"}`;
}

function renderCustomRegistrationFields(fields) {
    const form = document.getElementById("registrationForm");
    if (!form) return;
    form.querySelectorAll("[data-custom-registration-field]").forEach((node) => node.remove());
    const submit = document.getElementById("registrationSubmit");
    fields.forEach((field) => {
        if (!field || !field.key || !field.label) return;
        const label = document.createElement("label");
        label.className = "field";
        label.dataset.customRegistrationField = "true";
        label.append(document.createTextNode(field.label));
        let input;
        if (field.type === "select") {
            input = document.createElement("select");
            const placeholder = document.createElement("option");
            placeholder.value = ""; placeholder.textContent = `Select ${field.label.toLowerCase()}`; placeholder.disabled = true; placeholder.selected = true;
            input.append(placeholder);
            (field.options || []).forEach((value) => { const option = document.createElement("option"); option.value = value; option.textContent = value; input.append(option); });
        } else {
            input = document.createElement("input");
            input.type = ["text", "email", "tel", "number"].includes(field.type) ? field.type : "text";
        }
        input.name = `custom_${field.key}`;
        input.dataset.customKey = field.key;
        input.required = Boolean(field.required);
        label.append(input);
        form.insertBefore(label, submit);
    });
}

function customFieldEditorRow(field = {}) {
    const row = document.createElement("div");
    row.className = "custom-field-row";
    row.innerHTML = `
        <div class="custom-field-top"><span class="custom-field-number">Custom field</span><button type="button" class="btn btn--sm btn--danger" data-remove-field>Remove</button></div>
        <label class="field">Field label<input data-prop="label" maxlength="80" value="${escapeHtml(field.label || "")}" placeholder="Department" required></label>
        <label class="field">Field key<input data-prop="key" maxlength="40" pattern="[a-z][a-z0-9_]*" value="${escapeHtml(field.key || "")}" placeholder="department" required><small>Lowercase letters, numbers, and underscores; start with a letter.</small></label>
        <label class="field">Input type<select data-prop="type"><option value="text">Short text</option><option value="email">Email address</option><option value="tel">Phone number</option><option value="number">Number</option><option value="select">Dropdown</option></select></label>
        <label class="field custom-options">Dropdown options<input data-prop="options" value="${escapeHtml((field.options || []).join(", "))}" placeholder="IT, Commerce, Arts"><small>Separate options with commas.</small></label>
        <label class="check-row custom-required"><input data-prop="required" type="checkbox" ${field.required ? "checked" : ""}><span><strong>Required field</strong><small>Participants must fill this in.</small></span></label>
        <p class="field-error" data-field-error role="status"></p>`;
    row.querySelector('[data-prop="type"]').value = field.type || "text";
    const options = row.querySelector(".custom-options");
    const updateType = () => { options.hidden = row.querySelector('[data-prop="type"]').value !== "select"; };
    row.querySelector('[data-prop="type"]').addEventListener("change", () => { updateType(); markSettingsDirty(); });
    row.querySelectorAll("input, select").forEach((control) => control.addEventListener("input", () => { row.classList.remove("has-error"); markSettingsDirty(); updateSettingsPreview(); }));
    row.querySelector("[data-remove-field]").addEventListener("click", () => { row.remove(); updateCustomFieldCount(); markSettingsDirty(); updateSettingsPreview(); });
    updateType();
    return row;
}

let settingsInitialSnapshot = "";
let settingsIsDirty = false;
function settingsSnapshot(form, editor) {
    const payload = {};
    ["event_name", "organization_name", "event_date", "event_location", "event_description", "logo_url", "brand_color", "theme"].forEach((key) => payload[key] = form.elements.namedItem(key).value);
    ["registration_open", "scanner_sound", "scanner_vibration"].forEach((key) => payload[key] = form.elements.namedItem(key).checked);
    payload.course_options = form.elements.namedItem("course_options").value.split("\n").map((x) => x.trim()).filter(Boolean);
    payload.custom_fields = [...editor.querySelectorAll(".custom-field-row")].map((row) => ({
        label: row.querySelector('[data-prop="label"]').value.trim(),
        key: row.querySelector('[data-prop="key"]').value.trim(),
        type: row.querySelector('[data-prop="type"]').value,
        options: row.querySelector('[data-prop="options"]').value.split(",").map((x) => x.trim()).filter(Boolean),
        required: row.querySelector('[data-prop="required"]').checked,
    }));
    return payload;
}

function markSettingsDirty() {
    const form = document.getElementById("settingsForm");
    const editor = document.getElementById("customFieldsEditor");
    if (!form || !editor) return;
    settingsIsDirty = JSON.stringify(settingsSnapshot(form, editor)) !== settingsInitialSnapshot;
    const label = document.getElementById("settingsDirtyLabel");
    const title = document.getElementById("saveBarTitle");
    const hint = document.getElementById("saveBarHint");
    const discard = document.getElementById("discardSettingsButton");
    document.querySelector(".settings-status")?.classList.toggle("is-dirty", settingsIsDirty);
    if (label) label.textContent = settingsIsDirty ? "Unsaved changes" : "All changes saved";
    if (title) title.textContent = settingsIsDirty ? "You have unsaved changes" : "Settings are up to date";
    if (hint) hint.textContent = settingsIsDirty ? "Save to apply these changes across the app." : "Your latest settings are saved.";
    if (discard) discard.disabled = !settingsIsDirty;
}

function updateCustomFieldCount() {
    const count = document.querySelectorAll("#customFieldsEditor .custom-field-row").length;
    const target = document.getElementById("customFieldCount");
    if (target) target.textContent = `${count} ${count === 1 ? "field" : "fields"}`;
    document.querySelectorAll(".custom-field-number").forEach((node, index) => node.textContent = `Custom field ${index + 1}`);
}

function updateSettingsPreview() {
    const form = document.getElementById("settingsForm");
    const editor = document.getElementById("customFieldsEditor");
    if (!form || !editor) return;
    const value = (key) => form.elements.namedItem(key).value.trim();
    const eventName = value("event_name") || "Your event name";
    const organization = value("organization_name") || "Organization name";
    const date = value("event_date");
    const location = value("event_location");
    const name = document.getElementById("previewEventName");
    const org = document.getElementById("previewOrganization");
    const mark = document.getElementById("previewBrandMark");
    const color = value("brand_color") || "#0b6fb8";
    applyTheme(value("theme") || "system");
    const rgb = color.match(/^#([0-9a-f]{6})$/i);
    if (rgb) {
        const hex = rgb[1];
        const channels = [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4));
        const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
        document.documentElement.style.setProperty("--on-brand", luminance > 0.42 ? "#102033" : "#ffffff");
    }
    const colorValue = document.getElementById("brandColorValue");
    if (name) name.textContent = eventName;
    if (org) org.textContent = organization;
    if (mark) {
        mark.textContent = eventName.slice(0, 1).toUpperCase();
        const logo = value("logo_url");
        mark.innerHTML = "";
        if (logo) {
            const img = document.createElement("img");
            img.src = logo; img.alt = "";
            img.onerror = () => { mark.textContent = eventName.slice(0, 1).toUpperCase(); };
            mark.append(img);
        } else mark.textContent = eventName.slice(0, 1).toUpperCase();
    }
    if (colorValue) colorValue.textContent = color.toUpperCase();
    document.documentElement.style.setProperty("--brand", color);
    document.documentElement.style.setProperty("--brand-hover", color);
    document.documentElement.style.setProperty("--brand-tint", `${color}20`);
    const meta = document.getElementById("summaryEventMeta");
    if (meta) meta.textContent = [date, location].filter(Boolean).join(" · ") || "Set a date and location to show them here.";
    const summaryName = document.getElementById("summaryEventName");
    if (summaryName) summaryName.textContent = eventName;
    const reg = document.getElementById("summaryRegistration");
    if (reg) { reg.textContent = form.elements.namedItem("registration_open").checked ? "Open" : "Closed"; reg.classList.toggle("is-closed", !form.elements.namedItem("registration_open").checked); }
    const fields = document.getElementById("summaryFields");
    if (fields) fields.textContent = editor.querySelectorAll(".custom-field-row").length;
    const sound = document.getElementById("summarySound");
    if (sound) sound.textContent = form.elements.namedItem("scanner_sound").checked ? "On" : "Off";
    const vibration = document.getElementById("summaryVibration");
    if (vibration) vibration.textContent = form.elements.namedItem("scanner_vibration").checked ? "On" : "Off";
    const preview = document.getElementById("brandPreview");
    if (preview) preview.style.setProperty("--preview-brand", color);
}

function populateSettingsForm(form, editor, config) {
    Object.entries(config).forEach(([key, value]) => {
        const control = form.elements.namedItem(key);
        if (!control) return;
        if (control.type === "checkbox") control.checked = Boolean(value);
        else if (key === "course_options") control.value = (value || []).join("\n");
        else if (control.type !== "file") control.value = value ?? "";
    });
    editor.replaceChildren();
    (config.custom_fields || []).forEach((field) => editor.append(customFieldEditorRow(field)));
    updateCustomFieldCount();
    updateSettingsPreview();
    settingsInitialSnapshot = JSON.stringify(settingsSnapshot(form, editor));
    settingsIsDirty = false;
    markSettingsDirty();
}

async function initSettingsPage() {
    const form = document.getElementById("settingsForm");
    if (!form) return;
    const message = document.getElementById("settingsMessage");
    const editor = document.getElementById("customFieldsEditor");
    const saveButton = document.getElementById("saveSettingsButton");
    try {
        const config = await parseJsonResponse(await authFetch("/api/settings", { cache: "no-store" }));
        populateSettingsForm(form, editor, config);
    } catch (error) {
        setMessage(message, `Could not load settings: ${error.message}`, "error");
        saveButton.disabled = true;
        return;
    }
    document.getElementById("addCustomField").addEventListener("click", () => {
        if (editor.querySelectorAll(".custom-field-row").length >= 30) {
            setMessage(message, "You can add up to 30 custom fields.", "warning");
            return;
        }
        editor.append(customFieldEditorRow());
        updateCustomFieldCount(); markSettingsDirty(); updateSettingsPreview();
        editor.lastElementChild?.querySelector('[data-prop="label"]')?.focus();
    });
    form.addEventListener("input", () => { markSettingsDirty(); updateSettingsPreview(); });
    form.addEventListener("change", () => { markSettingsDirty(); updateSettingsPreview(); });
    window.addEventListener("beforeunload", (event) => {
        if (!settingsIsDirty) return;
        event.preventDefault();
        event.returnValue = "";
    });
    document.getElementById("discardSettingsButton").addEventListener("click", async () => {
        if (!settingsIsDirty) return;
        try {
            const config = await parseJsonResponse(await authFetch("/api/settings", { cache: "no-store" }));
            populateSettingsForm(form, editor, config);
            setMessage(message, "Unsaved changes discarded.", "success");
        } catch (error) { setMessage(message, `Could not reload settings: ${error.message}`, "error"); }
    });
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const payload = settingsSnapshot(form, editor);
        const keys = new Set();
        let invalidRow = null;
        for (const row of editor.querySelectorAll(".custom-field-row")) {
            const keyInput = row.querySelector('[data-prop="key"]');
            const labelInput = row.querySelector('[data-prop="label"]');
            const type = row.querySelector('[data-prop="type"]').value;
            const optionsText = row.querySelector('[data-prop="options"]').value;
            const errorNode = row.querySelector("[data-field-error]");
            row.classList.remove("has-error"); errorNode.textContent = "";
            if (!labelInput.value.trim() || !keyInput.checkValidity()) {
                errorNode.textContent = "Add a label and a valid field key."; invalidRow = row;
            } else if (keys.has(keyInput.value.trim())) {
                errorNode.textContent = "Each field key must be unique."; invalidRow = row;
            } else if (type === "select" && !optionsText.split(",").some((option) => option.trim())) {
                errorNode.textContent = "Add at least one dropdown option."; invalidRow = row;
            }
            keys.add(keyInput.value.trim());
            if (invalidRow) { row.classList.add("has-error"); break; }
        }
        if (invalidRow) {
            setMessage(message, "Please fix the highlighted custom field before saving.", "error");
            invalidRow.scrollIntoView({ behavior: "smooth", block: "center" });
            invalidRow.querySelector("input:invalid")?.focus();
            return;
        }
        const courseOptions = [...new Set(payload.course_options)];
        if (!courseOptions.length) {
            setMessage(message, "Add at least one course or category option.", "error");
            form.elements.namedItem("course_options").focus();
            return;
        }
        payload.course_options = courseOptions;
        setButtonLoading(saveButton, true, "Saving...");
        saveButton.disabled = true;
        try {
            const saved = await parseJsonResponse(await authFetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }));
            appConfig = saved;
            applyAppConfig();
            populateSettingsForm(form, editor, saved);
            setMessage(message, "Settings saved successfully. Your event pages will use the updated configuration.", "success");
        } catch (error) { setMessage(message, error.message, "error"); }
        finally { setButtonLoading(saveButton, false); saveButton.disabled = false; }
    });
}

function initRegistrationPage() {
    const form = document.getElementById("registrationForm");
    const message = document.getElementById("registrationMessage");
    const resultCard = document.getElementById("registrationResult");
    const submitButton = document.getElementById("registrationSubmit");
    const tokenTarget = document.getElementById("resultToken");
    const qrImage = document.getElementById("qrImage");
    const downloadButton = document.getElementById("downloadQrButton");

    const ticketFields = { name: "ticketName", roll_no: "ticketRoll", course: "ticketCourse" };
    function showTicketDetails(values) {
        Object.entries(ticketFields).forEach(([key, id]) => {
            const node = document.getElementById(id);
            const value = (values[key] || "").trim();
            node.textContent = value || "—";
            node.classList.toggle("is-empty", !value);
        });
    }

    // Live preview: typing a new registration resets an issued ticket.
    form.addEventListener("input", () => {
        if (resultCard.dataset.state === "issued") {
            resultCard.dataset.state = "empty";
            qrImage.removeAttribute("src");
            setMessage(message, "");
        }
        showTicketDetails(Object.fromEntries(new FormData(form).entries()));
    });

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        setMessage(message, "Issuing pass…");
        setButtonLoading(submitButton, true, "Issuing pass…");

        const formData = new FormData(form);
        const rawPayload = Object.fromEntries(formData.entries());
        const extraData = {};
        form.querySelectorAll("[data-custom-key]").forEach((input) => { extraData[input.dataset.customKey] = rawPayload[input.name] || ""; delete rawPayload[input.name]; });
        const payload = { ...rawPayload, extra_data: extraData };
        showTicketDetails(payload);

        try {
            const data = await parseJsonResponse(
                await fetch("/register", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                })
            );

            tokenTarget.textContent = data.token;
            qrImage.src = data.qr_code_url;
            qrImage.alt = `QR code for token ${data.token}`;
            downloadButton.href = data.qr_code_url;
            downloadButton.download = `${data.token}.png`;
            resultCard.dataset.state = "issued";
            setMessage(message, "Pass issued. Download the QR or show it at the gate.", "success");
            form.reset();
            if (window.matchMedia("(max-width: 960px)").matches) {
                resultCard.scrollIntoView({ behavior: "smooth", block: "start" });
            }
        } catch (error) {
            setMessage(message, error.message, "error");
        } finally {
            setButtonLoading(submitButton, false);
        }
    });
}

// ======================================================
// Scanner Page
// ======================================================

// Maps the existing verification status values (already used by the
// Scan Result card) to the camera card's status classes. Reused here
// so the Camera/Scanner card mirrors the same status without any new
// status variables being introduced.
const CAMERA_STATUS_CLASS_MAP = {
    neutral: "camera-status-default",
    valid: "camera-status-success",
    used: "camera-status-warning",
    invalid: "camera-status-error",
};

function setCameraCardStatus(status) {
    const scannerPanel = document.querySelector(".scanner-panel");
    if (!scannerPanel) return;

    // Remove any previously applied status class so only one is active.
    Object.values(CAMERA_STATUS_CLASS_MAP).forEach((className) => {
        scannerPanel.classList.remove(className);
    });

    const nextClass = CAMERA_STATUS_CLASS_MAP[status] || CAMERA_STATUS_CLASS_MAP.neutral;
    scannerPanel.classList.add(nextClass);
}

function setScanStatus(status, title, message) {
    const container = document.getElementById("scanStatus");
    const titleNode = document.getElementById("scanTitle");
    const messageNode = document.getElementById("scanMessage");

    container.className = `scan-status ${status}`;
    titleNode.textContent = title;
    messageNode.textContent = message;

    // Mirror the same verification status onto the Camera/Scanner card.
    setCameraCardStatus(status);
}

function initScannerPage() {
    const scannerHint = document.getElementById("scannerHint");
    const switchCameraButton = document.getElementById("switchCameraButton");
    let isVerifying = false;
    let scanLockedUntil = 0;
    let lastToken = "";
    let html5QrCode = null;
    let scannerActive = false;
    let scannerBusy = false;
    let currentFacingMode = "environment";

    function setSwitchButtonState(label = "Switch camera", disabled = false) {
        if (!switchCameraButton) return;
        switchCameraButton.textContent = label;
        switchCameraButton.disabled = disabled;
    }

    async function verifyToken(token) {
        const trimmedToken = token.trim();
        if (!trimmedToken) return;

        const now = Date.now();
        if (isVerifying || now < scanLockedUntil || trimmedToken === lastToken) return;

        isVerifying = true;
        scanLockedUntil = now + 1800;
        lastToken = trimmedToken;
        scannerHint.textContent = "QR detected. Verifying entry...";

        try {
            const result = await parseJsonResponse(
                await fetch("/verify", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token: trimmedToken }),
                })
            );

            playScannerFeedback(result.status);

            if (result.status === "VALID") {
                setScanStatus("valid", "Entry allowed", result.message);
            } else if (result.status === "USED") {
                setScanStatus("used", "Already used", result.message);
            } else {
                setScanStatus("invalid", "Invalid QR", result.message);
            }
        } catch (error) {
            playScannerFeedback("INVALID");
            setScanStatus("invalid", "Verification Failed", error.message);
        } finally {
            scannerHint.textContent = `Scanner is active using the ${currentFacingMode === "environment" ? "rear" : "front"} camera.`;
            window.setTimeout(() => {
                isVerifying = false;
                lastToken = "";
            }, 1600);
        }
    }

    async function startScanner() {
        if (scannerBusy) return;

        scannerBusy = true;
        setSwitchButtonState(scannerActive ? "Switching..." : "Starting...", true);

        try {
            if (!html5QrCode) {
                html5QrCode = new Html5Qrcode("scannerViewport");
            }

            if (scannerActive) {
                await html5QrCode.stop();
                scannerActive = false;
            }

            await html5QrCode.start(
                { facingMode: currentFacingMode },
                {
                    fps: 10,
                    qrbox: (viewportWidth, viewportHeight) => {
                        const size = Math.floor(Math.min(viewportWidth, viewportHeight) * 0.76);
                        return { width: size, height: size };
                    },
                },
                (decodedText) => verifyToken(decodedText),
                () => {}
            );

            scannerActive = true;
            scannerHint.textContent = `Scanner is active using the ${currentFacingMode === "environment" ? "rear" : "front"} camera.`;
            setScanStatus("neutral", "Ready to scan", "Hold a student QR pass in front of the camera.");
        } catch (error) {
            scannerHint.textContent = "Camera start failed. Please allow access and refresh the page.";
            setScanStatus("invalid", "Scanner unavailable", String(error));
            throw error;
        } finally {
            scannerBusy = false;
            setSwitchButtonState("Switch camera", false);
        }
    }

    function waitForScannerLibrary() {
        if (typeof Html5Qrcode === "undefined") {
            window.setTimeout(waitForScannerLibrary, 150);
            return;
        }

        startScanner().catch(async () => {
            if (currentFacingMode === "environment") {
                currentFacingMode = "user";
                try {
                    await startScanner();
                } catch {
                    scannerHint.textContent = "Unable to access a compatible camera on this device.";
                }
            }
        });
    }

    switchCameraButton?.addEventListener("click", async () => {
        const previousFacingMode = currentFacingMode;
        currentFacingMode = previousFacingMode === "environment" ? "user" : "environment";

        try {
            await startScanner();
        } catch (error) {
            currentFacingMode = previousFacingMode;
            try {
                await startScanner();
            } catch {
                scannerHint.textContent = "Unable to switch camera on this device.";
            }
        }
    });

    waitForScannerLibrary();
}

// ======================================================
// Admin Page
// ======================================================

function renderStudents(students, activeFilter) {
    const tableBody = document.getElementById("studentsTableBody");
    const searchValue = document.getElementById("searchRoll").value.trim().toLowerCase();

    const filteredStudents = students.filter((student) => {
        const matchesSearch = student.roll_no.toLowerCase().includes(searchValue);
        const matchesFilter =
            activeFilter === "all" ||
            (activeFilter === "used" && student.is_used) ||
            (activeFilter === "not-used" && !student.is_used);
        return matchesSearch && matchesFilter;
    });

    if (!filteredStudents.length) {
        tableBody.innerHTML = '<tr><td colspan="7" class="empty-state">No students match this search or filter.</td></tr>';
        return;
    }

    tableBody.innerHTML = filteredStudents
        .map((student) => {
            const qrUrl = buildStudentQrUrl(student);
            const action = student.is_used
                ? `<button type="button" class="btn btn--sm" data-reset-entry="${student.id}">Undo</button>`
                : `<button type="button" class="btn btn--sm btn--tint" data-manual-entry="${student.id}">Check in</button>`;
            return `
                <tr>
                    <td class="student"><strong>${escapeHtml(student.name)}</strong><small>${escapeHtml(student.roll_no)} &middot; ${escapeHtml(student.course)}</small>${Object.entries(student.extra_data || {}).filter(([, value]) => String(value || "").trim()).map(([key, value]) => `<small>${escapeHtml(key.replaceAll("_", " "))}: ${escapeHtml(value)}</small>`).join("")}</td>
                    <td>${escapeHtml(student.contact)}</td>
                    <td><span class="badge ${student.is_used ? "used" : "not-used"}">${student.is_used ? "Checked in" : "Not entered"}</span></td>
                    <td>
                        <a class="qr-thumb-link" href="${qrUrl}" target="_blank" rel="noopener">
                            <img class="qr-thumb" src="${qrUrl}" alt="QR code for ${escapeHtml(student.name)}">
                        </a>
                    </td>
                    <td class="when">${escapeHtml(formatDate(student.created_at))}</td>
                    <td class="when">${escapeHtml(formatDate(student.entry_at))}</td>
                    <td>
                        <div class="row-actions">
                            ${action}
                            <button type="button" class="btn btn--sm btn--icon" title="Send pass on WhatsApp" aria-label="Send pass to ${escapeHtml(student.name)} on WhatsApp" data-share-student="${escapeHtml(JSON.stringify(student))}">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 4 10 14M21 4l-6.5 17-3.5-7-7-3.5z"/></svg>
                            </button>
                            <button type="button" class="btn btn--sm btn--icon btn--danger" title="Delete student" aria-label="Delete ${escapeHtml(student.name)}" data-delete-student="${student.id}">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        })
        .join("");
}

function updateAdminStats(students) {
    const total = students.length;
    const used = students.filter((s) => s.is_used).length;
    const remaining = total - used;

    document.getElementById("statTotal").textContent = String(total);
    document.getElementById("statUsed").textContent = String(used);
    document.getElementById("statRemaining").textContent = String(remaining);

    const percent = total ? Math.round((used / total) * 100) : 0;
    document.getElementById("statPercent").textContent = `${percent}%`;
    document.getElementById("statProgress").style.width = `${percent}%`;
}

function setActiveFilterButton(activeFilter) {
    document.querySelectorAll(".filter-chip").forEach((button) => {
        button.classList.toggle("active", button.dataset.filter === activeFilter);
    });
}

function initAdminPage() {
    const message = document.getElementById("adminMessage");
    const searchRoll = document.getElementById("searchRoll");
    const refreshButton = document.getElementById("refreshStudents");
    const downloadCsvButton = document.getElementById("downloadCsvButton");
    const tableBody = document.getElementById("studentsTableBody");
    const filterButtons = document.querySelectorAll(".filter-chip");
    let students = [];
    let activeFilter = "all";

    async function loadStudents(successMessage = null) {
        setMessage(message, "Loading students…");
        refreshButton.disabled = true;

        try {
            students = await parseJsonResponse(
                await authFetch("/students", { cache: "no-store" })
            );
            updateAdminStats(students);
            renderStudents(students, activeFilter);
            setMessage(message, successMessage || `${students.length} students registered.`, "success");
        } catch (error) {
            tableBody.innerHTML =
                '<tr><td colspan="7" class="empty-state">Could not load students. Check your connection and refresh.</td></tr>';
            setMessage(message, error.message, "error");
        } finally {
            refreshButton.disabled = false;
        }
    }

    function updateStudentState(studentId, updates) {
        students = students.map((s) =>
            String(s.id) !== String(studentId) ? s : { ...s, ...updates }
        );
    }

    tableBody.addEventListener("click", async (event) => {
        const shareButton = event.target.closest("button[data-share-student]");

        if (shareButton) {
            try {
                const student = JSON.parse(shareButton.dataset.shareStudent);
                const qrUrl = window.location.origin + buildStudentQrUrl(student);

                let phone = String(student.contact || "").replace(/\D/g, "");
                if (phone.length === 10) phone = "91" + phone;

                if (!phone) {
                    setMessage(message, "This student has no valid phone number to share to.", "error");
                    return;
                }

                const whatsappMessage =
                    `Hello ${student.name},\n\nYour entry QR code is ready.\n\nPlease show this QR code at the gate for entry.\n\nQR Link:\n${qrUrl}\n\nThank you.`;
                window.open(`https://wa.me/${phone}?text=${encodeURIComponent(whatsappMessage)}`, "_blank");
            } catch (error) {
                console.error(error);
                setMessage(message, "Could not open WhatsApp for this student.", "error");
            }
            return;
        }

        const button = event.target.closest(
            "button[data-manual-entry], button[data-reset-entry], button[data-delete-student]"
        );

        if (!button) return;

        const studentId =
            button.dataset.manualEntry ||
            button.dataset.resetEntry ||
            button.dataset.deleteStudent;

        const isResetAction = Boolean(button.dataset.resetEntry);
        const isDeleteAction = Boolean(button.dataset.deleteStudent);

        if (isResetAction && !window.confirm("Undo this check-in? The pass will work again.")) return;
        if (isDeleteAction && !window.confirm("Are you sure you want to delete this student?")) return;

        const defaultHtml = button.innerHTML;
        button.disabled = true;
        if (!button.classList.contains("btn--icon")) button.textContent = "Updating…";

        try {
            if (button.dataset.manualEntry) {
                const data = await parseJsonResponse(
                    await authFetch(`/manual-entry/${studentId}`, { method: "POST" })
                );
                updateStudentState(studentId, { is_used: true, entry_at: data.entry_at });
                renderStudents(students, activeFilter);
                updateAdminStats(students);
                setMessage(message, data.message, "success");
                return;
            }

            if (button.dataset.resetEntry) {
                const data = await parseJsonResponse(
                    await authFetch(`/reset-entry/${studentId}`, { method: "POST" })
                );
                updateStudentState(studentId, { is_used: false, entry_at: data.entry_at });
                renderStudents(students, activeFilter);
                updateAdminStats(students);
                setMessage(message, data.message, "success");
                return;
            }

            const data = await parseJsonResponse(
                await authFetch(`/student/${studentId}`, { method: "DELETE" })
            );
            students = students.filter((s) => String(s.id) !== String(studentId));
            updateAdminStats(students);
            renderStudents(students, activeFilter);
            setMessage(message, data.message, "success");
        } catch (error) {
            button.disabled = false;
            button.innerHTML = defaultHtml;
            setMessage(message, error.message, "error");
        }
    });

    searchRoll.addEventListener("input", () => renderStudents(students, activeFilter));

    filterButtons.forEach((button) => {
        button.addEventListener("click", () => {
            activeFilter = button.dataset.filter;
            setActiveFilterButton(activeFilter);
            renderStudents(students, activeFilter);
        });
    });

    refreshButton.addEventListener("click", () => loadStudents());

    const importCsvButton = document.getElementById("importCsvButton");
    const importCsvInput = document.getElementById("importCsvInput");

    importCsvButton?.addEventListener("click", () => importCsvInput.click());

    importCsvInput?.addEventListener("change", async () => {
        const file = importCsvInput.files[0];
        if (!file) return;

        importCsvInput.value = "";
        importCsvButton.disabled = true;
        importCsvButton.textContent = "Importing…";
        setMessage(message, "Importing students from CSV...");

        const formData = new FormData();
        formData.append("file", file);

        try {
            const data = await parseJsonResponse(
                await authFetch("/import", { method: "POST", body: formData })
            );

            const summary = `Imported ${data.imported} student(s), skipped ${data.skipped}.`;
            const detail = data.errors.length
                ? ` Issues: ${data.errors.join(" | ")}`
                : "";
            setMessage(message, summary + detail, data.imported > 0 ? "success" : "error");
            await loadStudents();
        } catch (error) {
            setMessage(message, error.message, "error");
        } finally {
            importCsvButton.disabled = false;
            importCsvButton.textContent = "Import CSV";
        }
    });

    downloadCsvButton?.addEventListener("click", async () => {
        try {
            const response = await authFetch("/export");
            if (!response.ok) {
                throw new Error("Failed to download the CSV export.");
            }

            const blob = await response.blob();
            const blobUrl = window.URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = blobUrl;
            link.download = "students_export.csv";
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.URL.revokeObjectURL(blobUrl);
        } catch (error) {
            setMessage(message, error.message, "error");
        }
    });

    setActiveFilterButton(activeFilter);
    loadStudents();
}

// ======================================================
// Settings Page
// ======================================================
// Settings has no page-specific logic beyond the shared auth gate
// (see the DOMContentLoaded bootstrap below) plus the Lock Page
// feature, which is wired up by enableSessionLockButtons() above.

// ======================================================
// Lock Page
// ======================================================
// See enableSessionLockButtons() in the UI Helpers section above.

// ======================================================
// Event Listeners
// ======================================================

document.addEventListener("DOMContentLoaded", async () => {
    enableSessionLockButtons();
    await loadPublicConfig();

    if (page === "registration") {
        protectPage(initRegistrationPage);
    } else if (page === "scanner") {
        protectPage(initScannerPage);
    } else if (page === "admin") {
        protectPage(initAdminPage);
    } else if (page === "settings") {
        protectPage(initSettingsPage);
    }
});

// ======================================================
// Theme (Light / Dark / System)
// ======================================================
// Additive feature only — does not alter any code above.
// Reads/writes localStorage key "theme" with possible values
// "light", "dark", "system". Applies the resolved theme via
// the data-theme attribute on <html>, which style.css uses to
// override the existing CSS variables (--bg, --card-bg, etc.).

const THEME_STORAGE_KEY = "theme";
let themeMediaQuery = null;

// Returns "dark" or "light" based on the OS/browser preference.
function getSystemTheme() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
}

// Applies the given theme preference ("light" | "dark" | "system")
// to the document by resolving it to an actual "light"/"dark" value.
function applyTheme(theme) {
    const resolved = theme === "system" ? getSystemTheme() : theme;
    document.documentElement.setAttribute("data-theme", resolved);
}

// Persists the chosen preference, applies it immediately, and
// keeps the Settings dropdown (if present) in sync.
function setTheme(theme) {
    if (theme !== "light" && theme !== "dark" && theme !== "system") return;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    applyTheme(theme);

    const themeSelect = document.getElementById("themeSelect");
    if (themeSelect && themeSelect.value !== theme) {
        themeSelect.value = theme;
    }
}

// Reads the saved preference (defaulting to "system") and applies it.
// Returns the preference that was loaded.
function loadTheme() {
    const saved = localStorage.getItem(THEME_STORAGE_KEY) || "system";
    applyTheme(saved);
    return saved;
}

// Watches the OS color-scheme preference so that, while the site is
// open with "System" selected, the theme updates live if the user
// switches their OS theme.
function listenForSystemTheme() {
    if (!window.matchMedia) return;
    if (themeMediaQuery) return; // already listening

    themeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
        const current = localStorage.getItem(THEME_STORAGE_KEY) || "system";
        if (current === "system") {
            applyTheme("system");
        }
    };

    if (themeMediaQuery.addEventListener) {
        themeMediaQuery.addEventListener("change", handleChange);
    } else if (themeMediaQuery.addListener) {
        // Safari < 14 fallback
        themeMediaQuery.addListener(handleChange);
    }
}

// Wires up the Theme <select> on the Settings page, if present.
function initThemeSelector() {
    const themeSelect = document.getElementById("themeSelect");
    if (!themeSelect) return;

    themeSelect.value = localStorage.getItem(THEME_STORAGE_KEY) || "system";
    themeSelect.addEventListener("change", (event) => {
        setTheme(event.target.value);
    });
}

// Apply the saved/system theme as early as possible (script.js runs
// at the end of <body>, before the DOMContentLoaded/paint settles)
// to avoid a flash of the wrong theme.
loadTheme();
listenForSystemTheme();

document.addEventListener("DOMContentLoaded", () => {
    initThemeSelector();
});
