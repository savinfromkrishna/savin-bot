---
name: instagram-carousel
description: Plan, write and draw an Instagram carousel with carousel_render - structure, text limits, diagrams, caption and the checks before it goes out.
---

# Structure: 7 to 10 slides

1. Cover: a hook of at most 10 words that makes the reader need slide 2, and one line under it with the promise.
2. Middle slides: one idea each. Title up to 8 words; then a body of up to 45 words or 2 to 4 points; at most one formula, code block or diagram per slide.
3. Last slide: the recap in 3 points, then what to do next: save it, send it to a friend, follow.

# Drawing with carousel_render

- `folder`: `posts/instagram/<yyyy-mm-dd>-<slug>/`. `handle`: the page's @handle. `subject` picks the colour and the label on top.
- Formula: one line in Unicode (× ÷ ² ³ √ Δ ω τ θ Ω π ≈ ∝ → ∑ ∫). Say what every symbol means, with its unit, in the body or points of the same slide.
- Code: up to 8 lines of up to 40 characters, so it stays large enough to read on a phone.
- Wrap the one or two words that matter most in `**double asterisks**`.
- Diagram: one `<svg>` with `viewBox="0 0 900 560"`, lines 4 to 6 units thick, text at least 28 units. Draw lines and text in `currentColor`; mark the part that matters with `class="hl"` (lines) or `class="hl-fill"` (shapes, text). Give text `stroke="none"`. Nothing loads from outside, so no images or web fonts.

```svg
<svg viewBox="0 0 900 560" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="5" font-size="32">
  <rect x="40" y="220" width="220" height="110" rx="16"/>
  <text x="150" y="285" text-anchor="middle" fill="currentColor" stroke="none">Controller</text>
  <rect x="620" y="220" width="220" height="110" rx="16"/>
  <text x="730" y="285" text-anchor="middle" fill="currentColor" stroke="none">Motor</text>
  <path d="M260 275 H610" marker-end="url(#arrow)"/>
  <path class="hl" d="M730 330 V450 H150 V340" marker-end="url(#arrow)"/>
  <text class="hl-fill" x="440" y="500" text-anchor="middle" stroke="none">feedback: measured speed</text>
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="currentColor" stroke="none"/></marker></defs>
</svg>
```

- Read the preview that comes back. When it names a slide that does not fit, shorten or split that slide and draw again. Check every slide is readable at phone size, nothing is cut off, diagram labels do not overlap, and the slides look like one set.

# Caption (save as caption.md in the same folder)

1. First line: the hook, worded differently from the cover.
2. Two to four short lines with the key insight.
3. One question that invites a comment.
4. What to do next: save, share, follow the page.
5. 3 to 5 hashtags that fit this post, on the last line.

Keep it under 2,200 characters.
