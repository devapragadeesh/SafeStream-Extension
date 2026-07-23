const toggle = document.getElementById('toggle');
const statusEl = document.getElementById('status');

async function getActiveYouTubeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes('youtube.com/watch')) return tab;
    return null;
}

async function refreshStatus() {
    const tab = await getActiveYouTubeTab();
    if (!tab) {
        statusEl.textContent = 'Open a YouTube video to use this extension.';
        statusEl.className = 'status inactive';
        return;
    }

    let response;
    try {
        response = await chrome.tabs.sendMessage(tab.id, { type: 'get-status' });
    } catch (_) {
        statusEl.textContent = 'Waiting for page to load…';
        statusEl.className = 'status inactive';
        return;
    }

    if (!response) return;

    toggle.checked = response.enabled;

    if (!response.enabled) {
        statusEl.textContent = 'Muting disabled.';
        statusEl.className = 'status inactive';
    } else if (!response.videoFound) {
        statusEl.textContent = 'No video found on this page.';
        statusEl.className = 'status inactive';
    } else if (!response.hasCaption) {
        statusEl.textContent = 'No English captions available.';
        statusEl.className = 'status inactive';
    } else if (response.muteIntervals === 0) {
        statusEl.textContent = `Captions loaded (${response.captionSource}). No profanity found.`;
        statusEl.className = 'status inactive';
    } else {
        statusEl.textContent = `Active — ${response.muteIntervals} mute interval${response.muteIntervals !== 1 ? 's' : ''} (${response.captionSource})`;
        statusEl.className = 'status active';
    }
}

toggle.addEventListener('change', async () => {
    const tab = await getActiveYouTubeTab();
    if (!tab) return;
    await chrome.tabs.sendMessage(tab.id, { type: 'set-enabled', enabled: toggle.checked });
    await refreshStatus();
});

// Load initial enabled state from storage
chrome.storage.local.get(['enabled'], (result) => {
    toggle.checked = result.enabled !== false;
});

refreshStatus();
