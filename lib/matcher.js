(function () {
    'use strict';

    function buildBadWordSet(badWordsJson) {
        const normalized = new Set(); // alphanumeric-normalized words
        const raw = new Set();        // literal patterns like [_], [ __ ] kept as-is

        for (const category of Object.values(badWordsJson)) {
            for (const w of category) {
                const n = normalize(w);
                if (n.length > 0) {
                    normalized.add(n);
                } else {
                    // Normalizes to empty — keep as lowercased raw pattern
                    raw.add(w.toLowerCase().trim());
                }
            }
        }
        return { normalized, raw };
    }

    function coalescePlaceholders(captionWords) {
        // [ __ ] is split into three tokens by the XML tokenizer.
        // Merge any run of tokens that together form [ _+ ] into one token spanning the full run.
        const result = [];
        let i = 0;
        while (i < captionWords.length) {
            const w = captionWords[i].word.trim();
            // Detect start of a [ __ ] sequence
            if (w === '[') {
                let j = i + 1;
                // Collect underscore tokens
                while (j < captionWords.length && /^_+$/.test(captionWords[j].word.trim())) j++;
                // Expect closing ]
                if (j < captionWords.length && captionWords[j].word.trim() === ']') {
                    result.push({
                        word: '[__]',
                        startMs: captionWords[i].startMs,
                        endMs: captionWords[j].endMs,
                    });
                    i = j + 1;
                    continue;
                }
            }
            result.push(captionWords[i]);
            i++;
        }
        return result;
    }

    function buildMuteSchedule(rawCaptionWords, badWordSet) {
        const captionWords = coalescePlaceholders(rawCaptionWords);
        const intervals = [];
        const matched = [];

        for (let i = 0; i < captionWords.length; i++) {
            const { word, startMs, endMs } = captionWords[i];
            const n = normalize(word);
            const r = word.toLowerCase().trim();
            // [__] (coalesced placeholder) or any __+ token = always mute
            const isCensoredPlaceholder = r === '[__]' || /^_+$/.test(r);
            const isBad = isCensoredPlaceholder
                || (n.length > 0 && badWordSet.normalized.has(n))
                || badWordSet.raw.has(r);

            if (isBad) {
                matched.push(word);
                // Mute from this word's start to the next word's start (or this word's end if last)
                const nextStartMs = (i + 1 < captionWords.length) ? captionWords[i + 1].startMs : endMs;
                intervals.push({ startMs, endMs: nextStartMs });
            }
        }
        if (matched.length) console.log('[ProfanityMuter] Matched words:', matched);
        else console.log('[ProfanityMuter] No bad words matched in transcript');
        // Log unique tokens that contain brackets/underscores to help diagnose global patterns
        const suspectTokens = [...new Set(captionWords.map(w => w.word).filter(w => /[\[_\]]/.test(w)))];
        if (suspectTokens.length) console.log('[ProfanityMuter] Bracket/underscore tokens in transcript:', suspectTokens);

        return mergeIntervals(intervals);
    }

    function normalize(word) {
        return word.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    }

    function mergeIntervals(intervals) {
        if (intervals.length === 0) return [];
        intervals.sort((a, b) => a.startMs - b.startMs);

        const merged = [{ ...intervals[0] }];
        for (let i = 1; i < intervals.length; i++) {
            const last = merged[merged.length - 1];
            const cur = intervals[i];
            if (cur.startMs <= last.endMs) {
                last.endMs = Math.max(last.endMs, cur.endMs);
            } else {
                merged.push({ ...cur });
            }
        }
        return merged;
    }

    window.ProfanityMuter = window.ProfanityMuter || {};
    window.ProfanityMuter.buildBadWordSet = buildBadWordSet;
    window.ProfanityMuter.buildMuteSchedule = buildMuteSchedule;
})();
