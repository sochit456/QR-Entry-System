// ======================================================
// Global Variables
// ======================================================

let AUTH_PASSWORD = null;
const page = document.body.dataset.page;

// ======================================================
// Common Utility Functions
// ======================================================

async function loadConfig() {
    try {
        const res = await fetch("/config");
        if (!res.ok) throw new Error("Failed to load config");
        const data = await res.json();
        AUTH_PASSWORD = data.adminPassword;
    } catch (err) {
        console.error("Could not load app config:", err);
    }
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
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
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
    if (status === "VALID") {
        playToneSequence([{ frequency: 880, duration: 0.1, gap: 0.02 }]);
        vibratePattern(80);
        return;
    }

    if (status === "USED") {
        playToneSequence([
            { frequency: 540, duration: 0.1, gap: 0.03 },
            { frequency: 420, duration: 0.12, gap: 0.02 },
        ]);
        vibratePattern(180);
        return;
    }

    playToneSequence([
        { frequency: 240, duration: 0.12, type: "square", gap: 0.03 },
        { frequency: 180, duration: 0.24, type: "square", gap: 0.02 },
    ]);
    vibratePattern(320);
}

// Powers the "Lock Page" button on the Settings page (and any other
// page that includes a [data-lock-session] control).
function enableSessionLockButtons() {
    document.querySelectorAll("[data-lock-session]").forEach((button) => {
        button.addEventListener("click", () => {
            sessionStorage.removeItem("auth");
            window.location.reload();
        });
    });
}

// ======================================================
// Theme System
// ======================================================
// Applies a `theme-<name>` class to <html>, which drives every
// CSS custom property (colors, surfaces, shadows, etc.) defined
// in style.css. A tiny inline script in each page's <head> also
// applies the saved theme before first paint to avoid a flash.

const THEME_STORAGE_KEY = "theme";
const AVAILABLE_THEMES = ["blue", "green", "light", "dark"];
const DEFAULT_THEME = "blue";

function loadTheme() {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return AVAILABLE_THEMES.includes(saved) ? saved : DEFAULT_THEME;
}

function saveTheme(themeName) {
    try {
        localStorage.setItem(THEME_STORAGE_KEY, themeName);
    } catch (err) {
        console.error("Could not save theme preference:", err);
    }
}

function applyTheme(themeName) {
    const theme = AVAILABLE_THEMES.includes(themeName) ? themeName : DEFAULT_THEME;
    document.documentElement.className = `theme-${theme}`;
    updateThemeOptionButtons(theme);
    return theme;
}

function updateThemeOptionButtons(activeTheme) {
    document.querySelectorAll(".theme-option").forEach((button) => {
        button.classList.toggle("is-active", button.dataset.theme === activeTheme);
    });
}

function initThemeSystem() {
    // Ensure the class applied by the inline head script matches state
    // (also covers pages/tools where that inline script didn't run).
    applyTheme(loadTheme());
}

function initThemeSwitcher() {
    const themeButtons = document.querySelectorAll(".theme-option");
    if (!themeButtons.length) return;

    updateThemeOptionButtons(loadTheme());

    themeButtons.forEach((button) => {
        button.addEventListener("click", () => {
            const chosen = button.dataset.theme;
            saveTheme(chosen);
            applyTheme(chosen);
        });
    });
}

function protectPage(onAuthorized) {
    const overlay = document.getElementById("loginOverlay");
    const form = document.getElementById("authForm");
    const passwordInput = document.getElementById("authPassword");
    const error = document.getElementById("authError");
    const mainContent = document.getElementById("mainContent");
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
            overlay.style.display = "flex";
        }
        window.setTimeout(() => passwordInput?.focus(), 120);
    }

    if (!overlay || !form || !passwordInput || !mainContent) {
        showMainContent();
        return;
    }

    if (sessionStorage.getItem("auth") === "true") {
        showMainContent();
        return;
    }

    showLoginOverlay();

    form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (passwordInput.value === AUTH_PASSWORD) {
            sessionStorage.setItem("auth", "true");
            if (error) error.textContent = "";
            showMainContent();
            return;
        }

        sessionStorage.removeItem("auth");
        if (error) error.textContent = "Incorrect Password";
        passwordInput.select();
    });
}

// ======================================================
// Registration Page
// ======================================================

function initRegistrationPage() {
    const form = document.getElementById("registrationForm");
    const message = document.getElementById("registrationMessage");
    const resultCard = document.getElementById("registrationResult");
    const submitButton = document.getElementById("registrationSubmit");
    const tokenTarget = document.getElementById("resultToken");
    const qrImage = document.getElementById("qrImage");
    const downloadButton = document.getElementById("downloadQrButton");

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        setMessage(message, "Registering student and generating QR code...");
        setButtonLoading(submitButton, true, "Generating Pass...");

        const formData = new FormData(form);
        const payload = Object.fromEntries(formData.entries());

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
            resultCard.classList.remove("hidden");
            setMessage(message, "QR pass generated successfully.", "success");
            form.reset();
            resultCard.scrollIntoView({ behavior: "smooth", block: "start" });
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

function setScanStatus(status, title, message) {
    const container = document.getElementById("scanStatus");
    const titleNode = document.getElementById("scanTitle");
    const messageNode = document.getElementById("scanMessage");
    const pill = container.querySelector(".status-pill");

    container.className = `scan-status ${status}`;
    pill.textContent = status === "neutral" ? "Ready" : status.toUpperCase();
    titleNode.textContent = title;
    messageNode.textContent = message;
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

    function setSwitchButtonState(label = "Switch Camera", disabled = false) {
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
                setScanStatus("valid", "Entry Allowed", result.message);
            } else if (result.status === "USED") {
                setScanStatus("used", "Already Used", result.message);
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
            setScanStatus("neutral", "Waiting for scan", "Show a student QR code to the camera for instant verification.");
        } catch (error) {
            scannerHint.textContent = "Camera start failed. Please allow access and refresh the page.";
            setScanStatus("invalid", "Scanner Unavailable", String(error));
            throw error;
        } finally {
            scannerBusy = false;
            setSwitchButtonState("Switch Camera", false);
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
        tableBody.innerHTML = '<tr><td colspan="9" class="empty-state">No students match the current filter.</td></tr>';
        return;
    }

    tableBody.innerHTML = filteredStudents
        .map((student) => {
            const qrUrl = buildStudentQrUrl(student);
            return `
                <tr>
                    <td>${escapeHtml(student.name)}</td>
                    <td>${escapeHtml(student.roll_no)}</td>
                    <td>${escapeHtml(student.course)}</td>
                    <td class="contact-cell">${escapeHtml(student.contact)}</td>
                    <td>
                        <span class="status-badge ${student.is_used ? "used" : "not-used"}">
                            ${student.is_used ? "Used" : "Not Used"}
                        </span>
                    </td>
                    <td class="qr-cell">
                        <div class="qr-mini-card">
                            <a class="qr-thumb-link" href="${qrUrl}" target="_blank" rel="noopener">
                                <img class="qr-thumb" src="${qrUrl}" alt="QR code for ${escapeHtml(student.name)}">
                            </a>
                        </div>
                    </td>
                    <td>${escapeHtml(formatDate(student.created_at))}</td>
                    <td>${escapeHtml(formatDate(student.entry_at))}</td>
                    <td class="action-cell">
                        <div class="action-stack">
                            <button type="button" class="action-button action-button--success" data-manual-entry="${student.id}" ${student.is_used ? "disabled" : ""}>
                                Mark Present
                            </button>
                            <button type="button" class="action-button action-button--warning" data-reset-entry="${student.id}" ${student.is_used ? "" : "disabled"}>
                                Reset
                            </button>
                            <button type="button" class="action-button action-button--danger" data-delete-student="${student.id}">
                                Delete
                            </button>
                            <button type="button" class="action-button action-button--primary" data-share-student='${JSON.stringify(student)}'>
                                Share
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
        setMessage(message, "Loading registered students...");
        refreshButton.disabled = true;

        try {
            students = await parseJsonResponse(
                await fetch("/students", { cache: "no-store" })
            );
            updateAdminStats(students);
            renderStudents(students, activeFilter);
            setMessage(message, successMessage || `${students.length} Students Registered.`, "success");
        } catch (error) {
            tableBody.innerHTML =
                '<tr><td colspan="9" class="empty-state">Unable to load student data.</td></tr>';
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
                    alert("Invalid phone number");
                    return;
                }

                const whatsappMessage =
                    `Hello ${student.name},\n\nYour entry QR code is ready.\n\nPlease show this QR code at the gate for entry.\n\nQR Link:\n${qrUrl}\n\nThank you.`;
                window.open(`https://wa.me/${phone}?text=${encodeURIComponent(whatsappMessage)}`, "_blank");
            } catch (error) {
                console.error(error);
                alert("Unable to share QR.");
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

        if (isResetAction && !window.confirm("Are you sure?")) return;
        if (isDeleteAction && !window.confirm("Are you sure you want to delete this student?")) return;

        const defaultLabel = button.textContent.trim();
        button.disabled = true;
        button.textContent = isDeleteAction ? "Deleting..." : "Updating...";

        try {
            if (button.dataset.manualEntry) {
                const data = await parseJsonResponse(
                    await fetch(`/manual-entry/${studentId}`, { method: "POST" })
                );
                updateStudentState(studentId, { is_used: true, entry_at: data.entry_at });
                renderStudents(students, activeFilter);
                updateAdminStats(students);
                setMessage(message, data.message, "success");
                return;
            }

            if (button.dataset.resetEntry) {
                const data = await parseJsonResponse(
                    await fetch(`/reset-entry/${studentId}`, { method: "POST" })
                );
                updateStudentState(studentId, { is_used: false, entry_at: data.entry_at });
                renderStudents(students, activeFilter);
                updateAdminStats(students);
                setMessage(message, data.message, "success");
                return;
            }

            const data = await parseJsonResponse(
                await fetch(`/student/${studentId}`, { method: "DELETE" })
            );
            students = students.filter((s) => String(s.id) !== String(studentId));
            updateAdminStats(students);
            renderStudents(students, activeFilter);
            setMessage(message, data.message, "success");
        } catch (error) {
            button.disabled = false;
            button.textContent = defaultLabel;
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
        importCsvButton.textContent = "Importing...";
        setMessage(message, "Importing students from CSV...");

        const formData = new FormData();
        formData.append("file", file);

        try {
            const data = await parseJsonResponse(
                await fetch("/import", { method: "POST", body: formData })
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

    downloadCsvButton?.addEventListener("click", () => {
        const link = document.createElement("a");
        link.href = "/export";
        link.download = "students_export.csv";
        document.body.appendChild(link);
        link.click();
        link.remove();
    });

    setActiveFilterButton(activeFilter);
    loadStudents();
}

// ======================================================
// Settings Page
// ======================================================
// Settings has no auth-gated logic beyond the shared auth gate
// (see the DOMContentLoaded bootstrap below), plus the Lock Page
// feature (enableSessionLockButtons()) and the Theme picker
// (initThemeSwitcher()), both wired up below.

// ======================================================
// Lock Page
// ======================================================
// See enableSessionLockButtons() in the UI Helpers section above.

// ======================================================
// Event Listeners
// ======================================================

document.addEventListener("DOMContentLoaded", async () => {
    initThemeSystem();
    initThemeSwitcher();
    await loadConfig();
    enableSessionLockButtons();

    if (page === "registration") {
        protectPage(initRegistrationPage);
    } else if (page === "scanner") {
        protectPage(initScannerPage);
    } else if (page === "admin") {
        protectPage(initAdminPage);
    } else if (document.getElementById("loginOverlay") && document.getElementById("mainContent")) {
        // Any other protected page (e.g. settings) just needs the shared
        // auth gate; it has no page-specific init logic of its own.
        protectPage(() => {});
    }
});
