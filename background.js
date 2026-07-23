chrome.action.onClicked.addListener(async (tab) => {
    if (!tab.id || !tab.url || !tab.url.includes("youtube.com/watch")) {
        return;
    }
    await chrome.tabs.sendMessage(tab.id, { type: "toggle-url-overlay" });
});
