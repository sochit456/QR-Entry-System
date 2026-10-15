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
        renderCustomRegistrationFields(cfg.custom_fields || [], {});
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

function renderCustomRegistrationFields(fields, coreSettings = {}) {
    const form = document.getElementById("registrationForm");
    if (!form) return;
    form.querySelectorAll("[data-custom-registration-field], [data-configurable-core-field]").forEach((node) => { if (node.dataset.configurableCoreField) node.remove(); else node.remove(); });
    const submit = document.getElementById("registrationSubmit");
    const makeInput = (field, key, isCore = false) => {
        const wrapper = document.createElement("label");
        wrapper.className = `field ${field.width === "half" ? "configured-half" : field.width === "third" ? "configured-third" : "configured-full"}`;
        wrapper.dataset.customRegistrationField = isCore ? "false" : "true";
        if (isCore) wrapper.dataset.configurableCoreField = key;
        wrapper.append(document.createTextNode(field.label || key));
        let input;
        const type = field.type || "text";
        if (type === "select") {
            input = document.createElement("select");
            const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = field.placeholder || `Select ${String(field.label || key).toLowerCase()}`; placeholder.disabled = true; placeholder.selected = true; input.append(placeholder);
            const options = field.options || [];
            options.forEach((value) => { const option = document.createElement("option"); option.value = value; option.textContent = value; input.append(option); });
        } else if (type === "textarea") {
            input = document.createElement("textarea"); input.rows = 3;
        } else {
            input = document.createElement("input"); input.type = ["text","email","tel","number","date","url","checkbox"].includes(type) ? type : "text";
        }
        input.name = isCore ? key : `custom_${key}`;
        if (!isCore) input.dataset.customKey = key;
        input.required = Boolean(field.required && type !== "checkbox");
        input.placeholder = field.placeholder || "";
        if (type === "checkbox") { input.value = "true"; input.required = Boolean(field.required); }
        if (field.min_length) input.minLength = Number(field.min_length);
        if (field.max_length) input.maxLength = Number(field.max_length);
        if (field.min !== null && field.min !== undefined && field.min !== "") input.min = field.min;
        if (field.max !== null && field.max !== undefined && field.max !== "") input.max = field.max;
        if (field.pattern) input.pattern = field.pattern;
        wrapper.append(input);
        if (field.help_text) { const small = document.createElement("small"); small.textContent = field.help_text; wrapper.append(small); }
        form.insertBefore(wrapper, submit);
    };
    const existingName = form.querySelector('input[name="name"]')?.closest("label");
    fields.forEach((field) => { if (field && field.key && field.label) makeInput(field, field.key, false); });
}

function customFieldEditorRow(field = {}) {
    const row = document.createElement("div"); row.className = "custom-field-row";
    row.innerHTML = `
      <div class="custom-field-top"><span class="custom-field-number">Custom field</span><button type="button" class="btn btn--sm btn--danger" data-remove-field>Remove</button></div>
      <div class="form-grid field-editor-grid">
        <label class="field">Field label<input data-prop="label" maxlength="80" value="${escapeHtml(field.label || "")}" placeholder="Department" required></label>
        <label class="field">Field key<input data-prop="key" maxlength="40" pattern="[a-z][a-z0-9_]*" value="${escapeHtml(field.key || "")}" placeholder="department" required><small>Stable key; changing it won't rename existing saved data.</small></label>
        <label class="field">Input type<select data-prop="type"><option value="text">Short text</option><option value="textarea">Long text</option><option value="email">Email</option><option value="tel">Phone</option><option value="number">Number</option><option value="date">Date</option><option value="url">Website URL</option><option value="select">Dropdown</option><option value="checkbox">Checkbox</option></select></label>
        <label class="field">Layout width<select data-prop="width"><option value="full">Full width</option><option value="half">Half width</option><option value="third">One-third width</option></select></label>
        <label class="field">Placeholder<input data-prop="placeholder" maxlength="160" value="${escapeHtml(field.placeholder || "")}" placeholder="e.g. Enter department"></label>
        <label class="field">Help text<input data-prop="help_text" maxlength="250" value="${escapeHtml(field.help_text || "")}" placeholder="Shown below the field"></label>
        <label class="field custom-options">Dropdown options<input data-prop="options" value="${escapeHtml((field.options || []).join(", "))}" placeholder="IT, Commerce, Arts"><small>Separate options with commas.</small></label>
        <label class="field">Minimum length<input data-prop="min_length" type="number" min="0" max="500" value="${Number(field.min_length || 0)}"></label>
        <label class="field">Maximum length<input data-prop="max_length" type="number" min="1" max="5000" value="${Number(field.max_length || 250)}"></label>
        <label class="field">Minimum value<input data-prop="min" type="number" step="any" value="${field.min ?? ""}" placeholder="No minimum"></label>
        <label class="field">Maximum value<input data-prop="max" type="number" step="any" value="${field.max ?? ""}" placeholder="No maximum"></label>
        <label class="field">Custom validation pattern<input data-prop="pattern" maxlength="200" value="${escapeHtml(field.pattern || "")}" placeholder="e.g. [A-Z0-9]+"><small>Regular expression; leave blank for no custom pattern.</small></label>
      </div>
      <div class="field-rule-toggles">
        <label class="check-row"><input data-prop="required" type="checkbox" ${field.required ? "checked" : ""}><span><strong>Required</strong><small>Must be filled.</small></span></label>
        <label class="check-row"><input data-prop="unique" type="checkbox" ${field.unique ? "checked" : ""}><span><strong>Unique / no duplicates</strong><small>Reject an already registered value.</small></span></label>
        <label class="check-row"><input data-prop="search" type="checkbox" ${field.search ? "checked" : ""}><span><strong>Use for student search</strong><small>Must also be unique. Only one field is used.</small></span></label>
      </div><p class="field-error" data-field-error role="status"></p>`;
    row.querySelector('[data-prop="type"]').value = field.type || "text";
    row.querySelector('[data-prop="width"]').value = field.width || "full";
    const updateType = () => { row.querySelector(".custom-options").hidden = row.querySelector('[data-prop="type"]').value !== "select"; const numeric = row.querySelectorAll('[data-prop="min"], [data-prop="max"]'); numeric.forEach(el => el.closest("label").hidden = row.querySelector('[data-prop="type"]').value !== "number"); };
    row.querySelector('[data-prop="type"]').addEventListener("change", () => { updateType(); markSettingsDirty(); });
    row.querySelectorAll("input, select").forEach(control => control.addEventListener("input", () => { row.classList.remove("has-error"); if (control.dataset.prop === "search" && control.checked) { document.querySelectorAll('#customFieldsEditor [data-prop="search"]').forEach(other => { if (other !== control) other.checked = false; }); document.querySelectorAll('#coreFieldSettingsEditor [data-prop="search"]').forEach(other => other.checked = false); row.querySelector('[data-prop="unique"]').checked = true; } if (control.dataset.prop === "unique" && !control.checked) row.querySelector('[data-prop="search"]').checked = false; markSettingsDirty(); updateSettingsPreview(); }));
    row.querySelector("[data-remove-field]").addEventListener("click", () => { row.remove(); updateCustomFieldCount(); markSettingsDirty(); updateSettingsPreview(); }); updateType(); return row;
}

const CORE_FIELD_DEFAULTS = {
  roll_no:{label:"Roll number",type:"text",required:true,unique:true,search:true,placeholder:"Enter roll number",help_text:"",min_length:1,max_length:50,pattern:"",width:"half"},
  course:{label:"Course / category",type:"select",required:true,unique:false,search:false,placeholder:"Select course / category",help_text:"",min_length:0,max_length:120,pattern:"",width:"half"},
  contact:{label:"Contact number",type:"tel",required:true,unique:false,search:false,placeholder:"Enter contact number",help_text:"",min_length:0,max_length:50,pattern:"",width:"full"}
};
function coreFieldEditorRow(key, settings = {}) {
  const field = {...CORE_FIELD_DEFAULTS[key], ...settings}; const row=document.createElement("div"); row.className="custom-field-row core-field-row"; row.dataset.coreKey=key;
  row.innerHTML=`<div class="custom-field-top"><span class="custom-field-number">${escapeHtml(field.label)} <small>(key: ${key})</small></span><span class="count-pill">Built-in</span></div><div class="form-grid field-editor-grid">
  <label class="field">Field label<input data-prop="label" maxlength="80" value="${escapeHtml(field.label)}"></label>
  <label class="field">Input type<select data-prop="type"><option value="text">Short text</option><option value="textarea">Long text</option><option value="email">Email</option><option value="tel">Phone</option><option value="number">Number</option><option value="date">Date</option><option value="url">Website URL</option><option value="select">Dropdown</option></select></label>
  <label class="field">Layout width<select data-prop="width"><option value="full">Full width</option><option value="half">Half width</option><option value="third">One-third width</option></select></label>
  <label class="field">Placeholder<input data-prop="placeholder" maxlength="160" value="${escapeHtml(field.placeholder || "")}"></label><label class="field">Help text<input data-prop="help_text" maxlength="250" value="${escapeHtml(field.help_text || "")}"></label>
  <label class="field">Minimum length<input data-prop="min_length" type="number" min="0" max="500" value="${field.min_length || 0}"></label><label class="field">Maximum length<input data-prop="max_length" type="number" min="1" max="5000" value="${field.max_length || 250}"></label><label class="field">Minimum value<input data-prop="min" type="number" step="any" value="${field.min ?? ""}" placeholder="No minimum"></label><label class="field">Maximum value<input data-prop="max" type="number" step="any" value="${field.max ?? ""}" placeholder="No maximum"></label><label class="field">Validation pattern<input data-prop="pattern" maxlength="200" value="${escapeHtml(field.pattern || "")}" placeholder="Regular expression"></label></div>
  <div class="field-rule-toggles"><label class="check-row"><input data-prop="required" type="checkbox" ${field.required ? "checked" : ""}><span><strong>Required</strong></span></label><label class="check-row"><input data-prop="unique" type="checkbox" ${field.unique ? "checked" : ""}><span><strong>Unique / no duplicates</strong></span></label><label class="check-row"><input data-prop="search" type="checkbox" ${field.search ? "checked" : ""}><span><strong>Use for student search</strong></span></label></div><p class="field-error" data-field-error role="status"></p>`;
  row.querySelector('[data-prop="type"]').value=field.type; row.querySelector('[data-prop="width"]').value=field.width;
  row.querySelectorAll("input,select").forEach(control=>control.addEventListener("input",()=>{if(control.dataset.prop==="search"&&control.checked){row.querySelector('[data-prop="unique"]').checked=true;document.querySelectorAll('#customFieldsEditor [data-prop="search"]').forEach(other=>{if(other!==control)other.checked=false;});}if(control.dataset.prop==="unique"&&!control.checked)row.querySelector('[data-prop="search"]').checked=false;markSettingsDirty();})); return row;
}
let settingsInitialSnapshot = "";
let settingsIsDirty = false;
function settingsSnapshot(form, editor) {
    const payload = {};
    ["event_name", "organization_name", "event_date", "event_location", "event_description", "logo_url", "brand_color", "theme"].forEach((key) => payload[key] = form.elements.namedItem(key).value);
    ["registration_open", "scanner_sound", "scanner_vibration"].forEach((key) => payload[key] = form.elements.namedItem(key).checked);
    payload.custom_fields = [...editor.querySelectorAll(".custom-field-row")].map((row) => {
        const get = (key) => row.querySelector(`[data-prop="${key}"]`);
        return {label:get("label").value.trim(),key:get("key").value.trim(),type:get("type").value,options:(get("options")?.value || "").split(",").map(x=>x.trim()).filter(Boolean),required:get("required").checked,unique:get("unique").checked,search:get("search").checked,placeholder:get("placeholder").value,help_text:get("help_text").value,min_length:Number(get("min_length").value||0),max_length:Number(get("max_length").value||250),min:get("min")?.value || null,max:get("max")?.value || null,pattern:get("pattern").value,width:get("width").value};
    });
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
    document.querySelectorAll("#customFieldsEditor .custom-field-number").forEach((node, index) => node.textContent = `Custom field ${index + 1}`);
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

function initSettingsAccordion() {
    const sections = [...document.querySelectorAll("#settingsForm > .settings-section")];
    if (!sections.length) return;
    sections.forEach((section, index) => {
        const heading = section.querySelector(":scope > .section-heading");
        if (!heading) return;
        const body = [...section.children].filter(node => node !== heading);
        const toggle = document.createElement("button");
        toggle.type = "button"; toggle.className = "settings-accordion-trigger";
        toggle.setAttribute("aria-expanded", index === 0 ? "true" : "false");
        toggle.innerHTML = '<span class="accordion-chevron" aria-hidden="true">⌄</span>';
        heading.append(toggle); heading.classList.add("accordion-heading");
        body.forEach(node => node.classList.add("settings-accordion-content"));
        section.classList.toggle("is-collapsed", index !== 0);
        toggle.addEventListener("click", () => {
            const shouldOpen = section.classList.contains("is-collapsed");
            sections.forEach(other => { other.classList.add("is-collapsed"); other.querySelector(".settings-accordion-trigger")?.setAttribute("aria-expanded", "false"); });
            if (shouldOpen) { section.classList.remove("is-collapsed"); toggle.setAttribute("aria-expanded", "true"); }
        });
    });
}

async function initSettingsPage() {
    const form = document.getElementById("settingsForm");
    if (!form) return;
    const message = document.getElementById("settingsMessage");
    const editor = document.getElementById("customFieldsEditor");
    const saveButton = document.getElementById("saveSettingsButton");
    initSettingsAccordion();
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
        const allRows = [...document.querySelectorAll("#customFieldsEditor .custom-field-row")];
        const selectedSearch = allRows.filter(row => row.querySelector('[data-prop="search"]')?.checked);
        if (selectedSearch.length > 1) { setMessage(message, "Choose only one student search field.", "error"); return; }
        selectedSearch.forEach(row => { row.querySelector('[data-prop="unique"]').checked = true; });
        if (allRows.length && !allRows.some(row => row.querySelector('[data-prop="unique"]')?.checked)) { setMessage(message, "Mark at least one field as unique so the dashboard can search records reliably.", "error"); return; }
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

    const ticketFields = { name: "ticketName" };
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
        form.querySelectorAll("[data-custom-key]").forEach((input) => { extraData[input.dataset.customKey] = input.type === "checkbox" ? input.checked : (rawPayload[input.name] || ""); delete rawPayload[input.name]; });
        const payload = { name: rawPayload.name || "", extra_data: extraData };
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

let adminSearchField = "";
let adminFieldLabels = {};
let adminFields = [];
function studentFieldValue(student, key) { if (key === "name") return student.name; const extra = (student.extra_data || {})[key]; return extra !== undefined && extra !== null && extra !== "" ? extra : (key === "roll_no" || key === "course" || key === "contact" ? student[key] : extra); }
function renderStudents(students, activeFilter) {
    const tableBody = document.getElementById("studentsTableBody");
    const tableHead = document.getElementById("studentsTableHead");
    const searchValue = document.getElementById("searchRoll").value.trim().toLowerCase();
    const columns = [{key:"name", label:"Name"}, ...adminFields.map(field => ({key:field.key, label:field.label || field.key}))];
    if (tableHead) tableHead.innerHTML = [...columns.map(col => `<th>${escapeHtml(col.label)}</th>`), "<th>Status</th>", "<th>QR</th>", "<th>Registered</th>", "<th>Entered</th>", "<th>Actions</th>"].join("");
    const filteredStudents = students.filter(student => {
        const searchText = String(studentFieldValue(student, adminSearchField) ?? "").toLowerCase();
        const matchesSearch = !searchValue || searchText.includes(searchValue);
        const matchesFilter = activeFilter === "all" || (activeFilter === "used" && student.is_used) || (activeFilter === "not-used" && !student.is_used);
        return matchesSearch && matchesFilter;
    });
    const colSpan = columns.length + 5;
    if (!filteredStudents.length) {
        tableBody.innerHTML = `<tr><td colspan="${colSpan}" class="empty-state">No students match this search or filter.</td></tr>`;
        return;
    }
    tableBody.innerHTML = filteredStudents.map(student => {
        const qrUrl = buildStudentQrUrl(student);
        const action = student.is_used ? `<button type="button" class="btn btn--sm" data-reset-entry="${student.id}">Undo</button>` : `<button type="button" class="btn btn--sm btn--tint" data-manual-entry="${student.id}">Enter</button>`;
        const dynamicCells = columns.map(col => `<td>${escapeHtml(studentFieldValue(student, col.key) ?? "") || "—"}</td>`).join("");
        return `<tr>${dynamicCells}<td><span class="badge ${student.is_used ? "used" : "not-used"}">${student.is_used ? "Checked in" : "Not entered"}</span></td><td><a class="qr-thumb-link" href="${qrUrl}" target="_blank" rel="noopener"><img class="qr-thumb" src="${qrUrl}" alt="QR code for ${escapeHtml(student.name)}"></a></td><td class="when">${escapeHtml(formatDate(student.created_at))}</td><td class="when">${escapeHtml(formatDate(student.entry_at))}</td><td><div class="row-actions">${action}<button type="button" class="btn btn--sm btn--icon" title="Send pass on WhatsApp" aria-label="Send pass to ${escapeHtml(student.name)} on WhatsApp" data-share-student="${escapeHtml(JSON.stringify(student))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 4 10 14M21 4l-6.5 17-3.5-7-7-3.5z"/></svg></button><button type="button" class="btn btn--sm btn--icon btn--danger" title="Delete student" aria-label="Delete ${escapeHtml(student.name)}" data-delete-student="${student.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg></button></div></td></tr>`;
    }).join("");
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
            const [studentData, publicConfig] = await Promise.all([
                authFetch("/students", { cache: "no-store" }).then(parseJsonResponse),
                fetch("/public-config", { cache: "no-store" }).then(parseJsonResponse)
            ]);
            students = studentData;
            adminFields = publicConfig.custom_fields || [];
            adminSearchField = publicConfig.search_field || (adminFields.find(f => f.unique)?.key || "name");
            adminFieldLabels = Object.fromEntries(adminFields.map(f=>[f.key,f.label||f.key]));
            searchRoll.placeholder = `Search by ${adminFieldLabels[adminSearchField] || adminSearchField}`;
            searchRoll.setAttribute("aria-label", searchRoll.placeholder);
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
