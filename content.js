'use strict';

// Loaded once; shared across navigations
let badWordSet = null;

async function loadBadWords() {
    if (badWordSet) return badWordSet;
    const url = chrome.runtime.getURL('bad_words.json');
    const res = await fetch(url);
    const json = await res.json();
    badWordSet = window.ProfanityMuter.buildBadWordSet(json);
    console.log('[ProfanityMuter] Bad word set — normalized:', badWordSet.normalized.size, 'raw:', badWordSet.raw.size);
    return badWordSet;
}

async function fetchCaptionsViaInnerTube(videoId, apiKey) {
    const playerUrl = `https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`;
    const playerRes = await fetch(playerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            context: {
                client: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en', gl: 'US' },
            },
            videoId,
        }),
    });

    console.log('[ProfanityMuter] InnerTube status:', playerRes.status);
    if (!playerRes.ok) return { ok: false, error: `InnerTube ${playerRes.status}`, xml: '' };

    const playerData = await playerRes.json();
    const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!tracks?.length) {
        console.log('[ProfanityMuter] playabilityStatus:', JSON.stringify(playerData?.playabilityStatus));
        return { ok: false, error: 'No caption tracks', xml: '' };
    }

    const isEnglish = (t) => t.languageCode?.toLowerCase().startsWith('en');
    const track = tracks.find((t) => t.kind === 'asr' && isEnglish(t))
        ?? tracks.find((t) => isEnglish(t));

    if (!track) return { ok: false, error: 'No English track', xml: '' };

    const xmlUrl = track.baseUrl.replace(/[&?]fmt=srv3/g, '');
    console.log('[ProfanityMuter] XML URL:', xmlUrl.slice(0, 120) + '...');
    console.log('[ProfanityMuter] URL has exp=xpe:', xmlUrl.includes('exp=xpe'));

    const xmlRes = await fetch(xmlUrl);
    console.log('[ProfanityMuter] XML status:', xmlRes.status);
    if (!xmlRes.ok) return { ok: false, error: `XML fetch ${xmlRes.status}`, xml: '' };

    const xml = await xmlRes.text();
    console.log('[ProfanityMuter] XML length:', xml.length, 'first 200:', xml.slice(0, 200));
    const source = track.kind === 'asr' ? 'auto-generated' : 'manual';
    return { ok: true, xml, isJson: false, source };
}

function getEnglishCaptionTrack() {
    // Prefer live global over script-tag parse — stays fresh with signed URLs
    const playerResponse = window.ytInitialPlayerResponse ?? (() => {
        for (const s of document.querySelectorAll('script')) {
            const m = s.textContent.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
            if (m) { try { return JSON.parse(m[1]); } catch (_) {} }
        }
        return null;
    })();

    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) return { track: null, source: 'none' };

    const isEnglish = (t) => t.languageCode?.toLowerCase().startsWith('en');
    const asr = tracks.find((t) => t.kind === 'asr' && isEnglish(t));
    if (asr) return { track: asr, source: 'auto-generated' };
    const manual = tracks.find((t) => isEnglish(t));
    if (manual) return { track: manual, source: 'manual' };
    return { track: null, source: 'none' };
}

// --- Muter lifecycle ---

let currentMuter = null;
let captionSource = 'none';
let hasCaption = false;
let muteIntervals = 0;

function destroyMuter() {
    if (currentMuter) {
        currentMuter.destroy();
        currentMuter = null;
    }
}

async function initMuter() {
    destroyMuter();

    const videoId = new URLSearchParams(window.location.search).get('v');
    if (!videoId) {
        console.log('[ProfanityMuter] No video ID in URL.');
        return;
    }

    const apiKey = (() => {
        try {
            if (window.yt?.config_?.INNERTUBE_API_KEY) return window.yt.config_.INNERTUBE_API_KEY;
            if (window.ytcfg?.data_?.INNERTUBE_API_KEY) return window.ytcfg.data_.INNERTUBE_API_KEY;
        } catch (_) {}
        for (const s of document.querySelectorAll('script')) {
            const m = s.textContent.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
            if (m) return m[1];
        }
        return null;
    })();

    console.log('[ProfanityMuter] videoId:', videoId, 'apiKey:', apiKey ? apiKey.slice(0, 8) + '...' : 'not found');

    // POST to InnerTube from the content script (youtube.com origin) with ANDROID client.
    // Content scripts carry the page's cookies, which is needed for the request to succeed,
    // while the ANDROID client context returns caption URLs without the PoToken (&exp=xpe) gate.
    let result;
    try {
        result = await fetchCaptionsViaInnerTube(videoId, apiKey);
    } catch (e) {
        console.log('[ProfanityMuter] InnerTube fetch error:', e.message);
        return;
    }

    if (!result?.ok) {
        console.log('[ProfanityMuter] Caption fetch failed:', result?.error ?? 'unknown');
        hasCaption = false;
        captionSource = 'none';
        return;
    }

    hasCaption = true;
    captionSource = result.source;

    const words = window.ProfanityMuter.parseCaptions(result);
    if (words.length === 0) {
        console.log('[ProfanityMuter] XML parsed but no words found.');
        return;
    }

    const bwSet = await loadBadWords();
    const schedule = window.ProfanityMuter.buildMuteSchedule(words, bwSet);
    muteIntervals = schedule.length;
    console.log(`[ProfanityMuter] ${words.length} words, ${schedule.length} mute intervals (${captionSource}).`);

    const video = document.querySelector('video');
    if (!video) {
        console.log('[ProfanityMuter] No <video> element found.');
        return;
    }

    currentMuter = new window.ProfanityMuter.Muter(video, schedule);
    currentMuter.start();
}

// --- Extension toggle ---

let enabled = true;

chrome.storage.local.get(['enabled'], (result) => {
    enabled = result.enabled !== false;
    if (enabled) initMuter();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'set-enabled') {
        enabled = message.enabled;
        chrome.storage.local.set({ enabled });
        if (enabled) {
            initMuter();
        } else {
            destroyMuter();
        }
        return false;
    }
    if (message?.type === 'get-status') {
        const video = document.querySelector('video');
        sendResponse({
            enabled,
            hasCaption,
            captionSource,
            muteIntervals,
            videoFound: !!video,
        });
        return false;
    }
});

// --- YouTube SPA navigation ---

let navToken = 0;

async function onNavigate() {
    const myToken = ++navToken;
    // Wait for YouTube's SPA to update the page state
    await new Promise((r) => setTimeout(r, 800));
    if (myToken !== navToken) return;
    hasCaption = false;
    captionSource = 'none';
    muteIntervals = 0;
    if (enabled) initMuter();
}

window.addEventListener('yt-navigate-finish', onNavigate);

const origPush = history.pushState;
history.pushState = function pushState(...args) {
    const result = origPush.apply(this, args);
    window.dispatchEvent(new Event('yt-location-change'));
    return result;
};

const origReplace = history.replaceState;
history.replaceState = function replaceState(...args) {
    const result = origReplace.apply(this, args);
    window.dispatchEvent(new Event('yt-location-change'));
    return result;
};

window.addEventListener('yt-location-change', onNavigate);
