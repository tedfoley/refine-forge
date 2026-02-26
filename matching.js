/**
 * Forge — Fuzzy Quote Matching Utilities
 * Finds feedback quote anchors in the original document text.
 */
(function () {
  'use strict';

  function normalizeWithMapping(str) {
    var normalized = '';
    var posMap = [];
    var inWhitespace = false;

    for (var i = 0; i < str.length; i++) {
      if (/\s/.test(str[i])) {
        if (!inWhitespace && normalized.length > 0) {
          normalized += ' ';
          posMap.push(i);
          inWhitespace = true;
        }
      } else {
        normalized += str[i];
        posMap.push(i);
        inWhitespace = false;
      }
    }

    if (normalized.endsWith(' ')) {
      normalized = normalized.slice(0, -1);
      posMap.pop();
    }

    return { normalized: normalized, posMap: posMap };
  }

  function mapPos(posMap, idx) {
    if (idx < 0) return 0;
    if (idx >= posMap.length) return posMap[posMap.length - 1] + 1;
    return posMap[idx];
  }

  function findBestMatch(needle, haystack) {
    if (!needle || !haystack) return null;
    if (needle.length < 3) return null;

    // 1. Exact match
    var idx = haystack.indexOf(needle);
    if (idx !== -1) return { start: idx, end: idx + needle.length };

    // 2. Case-insensitive
    var lowerNeedle = needle.toLowerCase();
    var lowerHaystack = haystack.toLowerCase();
    idx = lowerHaystack.indexOf(lowerNeedle);
    if (idx !== -1) return { start: idx, end: idx + needle.length };

    // 3. Whitespace-normalized
    var normNeedle = needle.replace(/\s+/g, ' ').trim();
    var hMap = normalizeWithMapping(haystack);
    idx = hMap.normalized.indexOf(normNeedle);
    if (idx !== -1) {
      return {
        start: mapPos(hMap.posMap, idx),
        end: mapPos(hMap.posMap, idx + normNeedle.length - 1) + 1
      };
    }

    // 4. Case-insensitive + normalized whitespace
    var normLower = normNeedle.toLowerCase();
    var hNormLower = hMap.normalized.toLowerCase();
    idx = hNormLower.indexOf(normLower);
    if (idx !== -1) {
      return {
        start: mapPos(hMap.posMap, idx),
        end: mapPos(hMap.posMap, idx + normLower.length - 1) + 1
      };
    }

    // 5. Anchor matching — first 3 words + last 3 words
    var words = normNeedle.split(' ');
    if (words.length >= 6) {
      var prefix = words.slice(0, 3).join(' ').toLowerCase();
      var suffix = words.slice(-3).join(' ').toLowerCase();
      var prefixIdx = hNormLower.indexOf(prefix);
      if (prefixIdx !== -1) {
        var suffixIdx = hNormLower.indexOf(suffix, prefixIdx);
        if (suffixIdx !== -1 && (suffixIdx - prefixIdx) < normNeedle.length * 2) {
          var end = suffixIdx + suffix.length;
          return {
            start: mapPos(hMap.posMap, prefixIdx),
            end: mapPos(hMap.posMap, end - 1) + 1
          };
        }
      }
    }

    // 6. Progressive prefix shortening
    var minChars = Math.max(20, Math.floor(normLower.length * 0.4));
    for (var len = normLower.length; len >= minChars; len -= 5) {
      var sub = normLower.substring(0, len);
      idx = hNormLower.indexOf(sub);
      if (idx !== -1) {
        return {
          start: mapPos(hMap.posMap, idx),
          end: mapPos(hMap.posMap, idx + len - 1) + 1
        };
      }
    }

    // 7. Progressive suffix shortening
    for (var len2 = normLower.length; len2 >= minChars; len2 -= 5) {
      var sub2 = normLower.substring(normLower.length - len2);
      idx = hNormLower.indexOf(sub2);
      if (idx !== -1) {
        return {
          start: mapPos(hMap.posMap, idx),
          end: mapPos(hMap.posMap, idx + len2 - 1) + 1
        };
      }
    }

    return null;
  }

  function injectHighlights(container, feedbackItems, onClickFn) {
    if (!container || !feedbackItems || feedbackItems.length === 0) return;

    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
    var textNodes = [];
    var n;
    while ((n = walker.nextNode())) {
      textNodes.push(n);
    }

    var fullText = '';
    var nodeMap = [];
    textNodes.forEach(function (tn) {
      var start = fullText.length;
      fullText += tn.textContent;
      nodeMap.push({ node: tn, start: start, end: fullText.length });
    });

    var itemsWithPos = feedbackItems.map(function (item) {
      var match = findBestMatch(item.quote, fullText);
      return { item: item, match: match };
    }).filter(function (x) { return x.match !== null; });

    itemsWithPos.sort(function (a, b) { return a.match.start - b.match.start; });

    // Process in REVERSE order to avoid position shifts
    for (var i = itemsWithPos.length - 1; i >= 0; i--) {
      var entry = itemsWithPos[i];
      try {
        wrapMatch(nodeMap, fullText, entry.match, entry.item.id, onClickFn);
      } catch (e) {
        // Silently skip failed highlights
      }
    }
  }

  function wrapMatch(nodeMap, fullText, match, id, onClick) {
    var startNodeInfo = null;
    var endNodeInfo = null;

    for (var i = 0; i < nodeMap.length; i++) {
      var nm = nodeMap[i];
      if (startNodeInfo === null && match.start >= nm.start && match.start < nm.end) {
        startNodeInfo = nm;
      }
      if (match.end > nm.start && match.end <= nm.end) {
        endNodeInfo = nm;
      }
    }

    if (!startNodeInfo) return;
    if (!endNodeInfo) endNodeInfo = startNodeInfo;

    var range = document.createRange();

    if (startNodeInfo.node === endNodeInfo.node) {
      var localStart = match.start - startNodeInfo.start;
      var localEnd = match.end - startNodeInfo.start;
      localEnd = Math.min(localEnd, startNodeInfo.node.textContent.length);
      range.setStart(startNodeInfo.node, localStart);
      range.setEnd(startNodeInfo.node, localEnd);
    } else {
      var ls = match.start - startNodeInfo.start;
      range.setStart(startNodeInfo.node, ls);
      range.setEnd(startNodeInfo.node, startNodeInfo.node.textContent.length);
    }

    var mark = document.createElement('mark');
    mark.className = 'highlight-anchor';
    mark.id = 'text-anchor-' + id;
    mark.setAttribute('data-feedback-id', String(id));
    mark.addEventListener('click', function () { onClick(id); });

    range.surroundContents(mark);

    var badge = document.createElement('sup');
    badge.className = 'highlight-badge';
    badge.textContent = String(id);
    mark.appendChild(badge);
  }

  window.ForgeMatching = {
    findBestMatch: findBestMatch,
    injectHighlights: injectHighlights,
  };
})();
