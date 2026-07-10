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
    overlay.style.display = "flex";
    overlay.innerHTML = `
        <div class="auth-card glass-panel fade-scale">
            <p class="section-tag">Session</p>
            <h2>Continue your session?</h2>
            <p class="section-copy">You refreshed the page. Your admin session is still active. Would you like to continue working?</p>
            <div class="action-stack">
                <button type="button" id="sessionContinueButton" class="primary-button primary-button--wide">Continue</button>
                <button type="button" id="sessionLogoutButton" class="secondary-button secondary-button--wide">Logout</button>
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
            overlay.style.display = "flex";
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
    const pill = container.querySelector(".status-pill");

    container.className = `scan-status ${status}`;
    pill.textContent = status === "neutral" ? "Ready" : status.toUpperCase();
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
                            <button type="button" class="action-button action-button--primary" data-share-id="${escapeHtml(String(student.id))}">
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
    let studentsById = new Map();
    let activeFilter = "all";

    async function loadStudents(successMessage = null) {
        setMessage(message, "Loading registered students...");
        refreshButton.disabled = true;

        try {
            students = await parseJsonResponse(
                await authFetch("/students", { cache: "no-store" })
            );
            studentsById = new Map(students.map((s) => [String(s.id), s]));
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
        studentsById = new Map(students.map((s) => [String(s.id), s]));
    }

    tableBody.addEventListener("click", async (event) => {
        const shareButton = event.target.closest("button[data-share-id]");

        if (shareButton) {
            try {
                const student = studentsById.get(String(shareButton.dataset.shareId));
                if (!student) {
                    alert("Unable to share QR.");
                    return;
                }
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
            studentsById = new Map(students.map((s) => [String(s.id), s]));
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

document.addEventListener("DOMContentLoaded", () => {
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
