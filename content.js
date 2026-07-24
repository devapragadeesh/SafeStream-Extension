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

    const source = track.kind === 'asr' ? 'auto-generated' : 'manual';

    // Prefer json3: it carries per-word tOffsetMs timing (and keeps a censored
    // "[ __ ]" token whole), which the segment-level XML format lacks. XML forces
    // linear word interpolation across a whole caption line, drifting a word's
    // estimated time by up to ~2s inside long segments — the cause of late mutes.
    const base = track.baseUrl
        .replace(/([&?])fmt=[^&]*/g, '$1')   // drop any existing fmt=
        .replace(/[?&]+$/g, '');             // tidy a dangling ? or &
    const json3Url = base + (base.includes('?') ? '&' : '?') + 'fmt=json3';

    try {
        const jsonRes = await fetch(json3Url);
        console.log('[ProfanityMuter] json3 status:', jsonRes.status);
        if (jsonRes.ok) {
            const text = await jsonRes.text();
            // Only accept json3 if it actually parses with non-empty events;
            // YouTube sometimes returns HTTP 200 with an empty body / no events,
            // which would silently mute nothing. Otherwise fall through to XML.
            let events = null;
            try { events = JSON.parse(text)?.events; } catch (_) {}
            if (events?.length) {
                console.log('[ProfanityMuter] json3 length:', text.length, 'events:', events.length);
                return { ok: true, xml: text, isJson: true, source };
            }
            console.log('[ProfanityMuter] json3 empty/invalid — falling back to XML');
        }
    } catch (e) {
        console.log('[ProfanityMuter] json3 fetch error:', e.message, '— falling back to XML');
    }

    // Fallback: legacy segment-level XML.
    const xmlUrl = track.baseUrl.replace(/[&?]fmt=srv3/g, '');
    const xmlRes = await fetch(xmlUrl);
    console.log('[ProfanityMuter] XML status:', xmlRes.status);
    if (!xmlRes.ok) return { ok: false, error: `XML fetch ${xmlRes.status}`, xml: '' };

    const xml = await xmlRes.text();
    console.log('[ProfanityMuter] XML length:', xml.length, 'first 200:', xml.slice(0, 200));
    return { ok: true, xml, isJson: false, source };
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

let lastInitVideoId = null;
// Tracks a videoId with an initMuter() call currently in-flight (awaiting fetch).
// Needed because `currentMuter` is only assigned at the very end of the async
// function, well after several `await`s — two calls for the same video fired
// close together (e.g. yt-navigate-finish landing on top of the initial
// chrome.storage.local.get callback on a cold load) would otherwise both pass
// the "already initialized" check below, both fetch concurrently, and leak the
// first Muter's event listeners when the second overwrites `currentMuter`.
let initInFlightVideoId = null;

async function initMuter() {
    const videoId = new URLSearchParams(window.location.search).get('v');
    if (!videoId) {
        console.log('[ProfanityMuter] No video ID in URL.');
        return;
    }
    if (videoId === lastInitVideoId && currentMuter) {
        // Same video already initialized (e.g. yt-navigate-finish firing on top of
        // the initial page load) — avoid a redundant caption re-fetch.
        return;
    }
    if (videoId === initInFlightVideoId) {
        // Another initMuter() call for this same video is already awaiting its
        // fetch — don't start a second one.
        return;
    }
    initInFlightVideoId = videoId;

    try {
        lastInitVideoId = videoId;
        await initMuterInner(videoId);
    } finally {
        if (initInFlightVideoId === videoId) initInFlightVideoId = null;
    }
}

async function initMuterInner(videoId) {
    destroyMuter();

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
    const schedule = window.ProfanityMuter.buildMuteSchedule(words, bwSet, {
        isAutoGenerated: captionSource === 'auto-generated',
    });
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

    // YouTube fires 'yt-navigate-finish'/'yt-location-change' for more than just
    // switching videos (e.g. history.replaceState calls for chapters, sidebar
    // updates, theater-mode toggles). If it's the same video we've already
    // initialized, this must be a no-op — wiping hasCaption/muteIntervals here
    // would otherwise permanently desync the popup's status display from the
    // still-running Muter, since initMuter()'s own dedup guard would then skip
    // re-fetching and never restore them.
    const videoId = new URLSearchParams(window.location.search).get('v');
    if (videoId === lastInitVideoId && currentMuter) return;

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
