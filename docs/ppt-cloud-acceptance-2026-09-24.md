# Native PPT cloud acceptance, 2026-09-24

## Environment

- Dedicated service: `moonwalk-ppt-render-verify`, Render free Docker plan.
- Application commit: `906db9d5c72f5d47ea3fc00111aa9c4ed2bf6d57`.
- Password protected; unauthenticated PPT API returns 401.
- Provider: existing GPT-5.6 Sol configuration, not DeepSeek.
- All native execution and screenshots run in Linux on Render; browser on macOS.
- Synthetic project: `627399fc3bc8c70072139cf17896d8a3`, three Chinese slides about
  campus backup recovery validation, no private business material.
- Production `moonwalk-docker` remains untouched at this checkpoint. Both service
  plans were independently read back as `free`.

## Observed workflow

1. Created project from the website with GPT selected and visual review enabled.
2. Submitted native stage-one communication contract in the browser. Stage two
   started only afterward.
3. Submitted native stage-two design/production choices in the browser.
4. Read and approved the full native design specification in its original UI.
5. Generated three visible SVG slides, including icons, an editable-table plan
   and a three-step process. Screenshots show readable Chinese and nonblank pages.
6. Native structure validation passed. Three Chinese notes and sidecar entrance
   animations passed native validation; the table remains a single editable unit.
7. Actual GPT screenshot review passed slide two and flagged insufficient
   contrast of small text on slides one and three. Export remained blocked.
8. Edited those two native spec blocks in the original editor, applied changes,
   ran the required consistency review and explicitly approved the revised spec.
   Confirmed scope is pages 1 and 3 only; content, palette and slide two unchanged.
9. Revised authoring completed. Review identified one remaining label color and
   the omitted word "backup" in slide three. Submitted precise per-page changes
   through the website, reviewed the scope and explicitly confirmed execution.
10. Native revision completed; all three pages passed actual GPT visual review.
    Export completed with native status `passed`. The browser download succeeded.

## Export evidence

- File: `moonwalk_1790235262442.pptx`, 29,976 bytes.
- SHA-256: `2798a7dca3c20acf13e726a548ffa788de9ff5152973b0aeb10a12b04347b634`.
- ZIP/XML inspection: three slides, three Chinese speaker-note parts, one native
  editable table (`a:tbl`), and object animation XML (`p:timing`) on all three slides.
- Browser download: `/Users/keyiyu/Downloads/moonwalk_1790235262442.pptx`.
- Production promotion is the next release operation, not part of this recorded
  test-service result.

Refresh and returning to the homepage did not stop the server-side task. This is
not a durability guarantee: restart/deployment can remove all temporary files.

## Adapter issue found

The original fixed-interval live preview can overlap reads on a low-CPU instance
(one observed slides-list request took 11.9 seconds). The website adapter now
shares pending slides-list GETs, without caching responses or changing the native
workflow. A focused test verifies independent readable response bodies, error
recovery and that writes are never combined. This fix is not yet on the live
acceptance deployment, so its project has not been discarded for a redeploy.

## Platform scope

Client functionality uses same-origin HTTPS, ordinary file inputs and browser
downloads. No Windows/macOS/Linux client installs a worker. Physical Windows and
Linux desktop browser acceptance has not been performed; do not claim otherwise.
