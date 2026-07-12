// Setup page: shows live helper status and links to the latest installer.
const api = (typeof browser !== "undefined" && browser.runtime) ? browser : chrome;

const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");

function render(helper) {
  const state = (helper && helper.state) || "disconnected";
  dot.className = "dot";
  if (state === "ready") {
    dot.classList.add("ok");
    statusText.textContent = "Helper is installed and ready — you're all set!";
  } else if (state === "no-ffmpeg") {
    dot.classList.add("warn");
    statusText.textContent = "Helper is installed, but ffmpeg wasn't found. Re-run the installer.";
  } else if (state === "connecting") {
    dot.classList.add("warn");
    statusText.textContent = "Connecting to the helper…";
  } else {
    dot.classList.add("off");
    statusText.textContent = "Helper not detected yet. Install it above, then restart Firefox or re-check.";
  }
}

async function check(recheck) {
  try {
    const resp = await api.runtime.sendMessage({ type: recheck ? "recheck-helper" : "helper-status" });
    render(resp && resp.helper);
  } catch (e) {
    render(null);
  }
}

document.getElementById("recheck").addEventListener("click", () => {
  statusText.textContent = "Re-checking…";
  check(true);
});

// Live updates: the background broadcasts helper-status whenever the connection changes.
api.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "helper-status") render(msg.helper);
});

check(false);
