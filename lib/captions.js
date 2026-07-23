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

    function parseJson3(data) {
        const words = [];
        const events = data?.events ?? [];

        for (const event of events) {
            const eventStartMs = event.tStartMs ?? 0;
            const segs = event.segs ?? [];

            let curOffsetMs = 0;
            for (let i = 0; i < segs.length; i++) {
                const seg = segs[i];
                const segOffsetMs = seg.tOffsetMs ?? curOffsetMs;
                curOffsetMs = segOffsetMs;

                const nextOffset = (i + 1 < segs.length)
                    ? (segs[i + 1].tOffsetMs ?? segOffsetMs + 500)
                    : segOffsetMs + 500;
                const segDurMs = Math.max(nextOffset - segOffsetMs, 100);

                const segText = (seg.utf8 ?? '').trim();
                if (!segText) continue;

                const segWords = segText.split(/\s+/).filter(Boolean);
                if (!segWords.length) continue;

                const msPerWord = segDurMs / segWords.length;
                for (let j = 0; j < segWords.length; j++) {
                    const wordStartMs = eventStartMs + segOffsetMs + j * msPerWord;
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
