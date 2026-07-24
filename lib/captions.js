(function () {
    'use strict';

    // Entry point: accepts { xml, isJson } from the background fetch result
    function parseCaptions(result) {
        if (result.isJson) {
            try {
                return parseJson3(JSON.parse(result.xml));
            } catch (e) {
                console.warn('[ProfanityMuter] JSON3 parse error:', e.message, '— falling back to XML');
            }
        }
        return parseCaptionXml(result.xml);
    }

    // Matches a censored placeholder token as a whole: [_], [ __ ], [___], etc.
    const CENSOR_RE = /^\[[\s_]*\]$/;

    function parseJson3(data) {
        const words = [];
        const events = data?.events ?? [];

        for (const event of events) {
            const eventStartMs = event.tStartMs ?? 0;
            const eventDurMs = event.dDurationMs ?? 0;
            const segs = event.segs ?? [];

            // In json3 each seg is its own timed token: seg.tOffsetMs is the ms
            // offset from eventStartMs at which the seg's text begins. Treat each
            // seg as one word so we keep that precise per-word timing (rather than
            // re-splitting and re-interpolating, which destroys it). A seg's end is
            // the next seg's offset, or the event duration for the last seg.
            let prevOffset = 0;
            for (let i = 0; i < segs.length; i++) {
                const startOffset = segs[i].tOffsetMs ?? (i === 0 ? 0 : prevOffset);
                prevOffset = startOffset;

                // End boundary = next seg that carries an offset (a whitespace-only
                // seg still counts as a boundary), else the event's own duration.
                let endOffset = null;
                for (let k = i + 1; k < segs.length; k++) {
                    if (segs[k].tOffsetMs != null) { endOffset = segs[k].tOffsetMs; break; }
                }
                if (endOffset == null) endOffset = eventDurMs > 0 ? eventDurMs : startOffset + 300;

                const segStartMs = eventStartMs + startOffset;
                const segEndMs = eventStartMs + endOffset;

                const segText = (segs[i].utf8 ?? '').trim();
                if (!segText) continue; // newline / spacer seg — boundary only, no token

                if (CENSOR_RE.test(segText)) {
                    // Keep the censored token whole with its exact timing.
                    words.push({ word: '[__]', startMs: Math.round(segStartMs), endMs: Math.round(segEndMs) });
                    continue;
                }

                const segWords = segText.split(/\s+/).filter(Boolean);
                if (segWords.length <= 1) {
                    words.push({ word: segText, startMs: Math.round(segStartMs), endMs: Math.round(segEndMs) });
                    continue;
                }

                // Rare: a seg holding a multi-word phrase (some manual tracks).
                // Interpolate only within this one short seg window — bounded, so it
                // does not reintroduce the long-segment smear that plagued XML.
                const msPerWord = Math.max(segEndMs - segStartMs, 1) / segWords.length;
                for (let j = 0; j < segWords.length; j++) {
                    const wordStartMs = segStartMs + j * msPerWord;
                    words.push({
                        word: segWords[j],
                        startMs: Math.round(wordStartMs),
                        endMs: Math.round(wordStartMs + msPerWord),
                    });
                }
            }
        }
        return words;
    }

    function parseCaptionXml(xmlText) {
        const words = [];
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, 'text/xml');
        const textNodes = doc.querySelectorAll('text');

        for (const node of textNodes) {
            const startSec = parseFloat(node.getAttribute('start') ?? '0');
            const durSec = parseFloat(node.getAttribute('dur') ?? '0.5');
            const startMs = Math.round(startSec * 1000);
            const durMs = Math.round(durSec * 1000);

            const raw = decodeEntities(node.textContent ?? '');
            const clean = raw.replace(/<[^>]*>/g, '').trim();
            const segWords = clean.split(/\s+/).filter(Boolean);
            if (!segWords.length) continue;

            const msPerWord = durMs / segWords.length;
            for (let i = 0; i < segWords.length; i++) {
                const wordStartMs = startMs + i * msPerWord;
                words.push({
                    word: segWords[i],
                    startMs: Math.round(wordStartMs),
                    endMs: Math.round(wordStartMs + msPerWord),
                });
            }
        }
        return words;
    }

    function decodeEntities(str) {
        const el = document.createElement('textarea');
        el.innerHTML = str;
        return el.value;
    }

    window.ProfanityMuter = window.ProfanityMuter || {};
    window.ProfanityMuter.parseCaptions = parseCaptions;
})();
