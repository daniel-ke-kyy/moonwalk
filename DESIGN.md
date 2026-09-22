---
name: Moonwalk Homepage
description: A spatial learning-material workspace with a directly accessible upload action.
colors:
  paper: "#f7f7f2"
  ink: "#292e2b"
  muted: "#69716b"
  line: "#dce0d6"
  yellow: "#e7db78"
  coral: "#c76b51"
  teal: "#4e7d77"
typography:
  display:
    fontFamily: "Snell Roundhand, Brush Script MT, Segoe Script, cursive"
    fontSize: "124px"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "0"
  body:
    fontFamily: "Moonwalk Sans, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "13px"
    lineHeight: 1.7
rounded:
  control: "8px"
  segment: "5px"
spacing:
  small: "12px"
  medium: "24px"
  large: "48px"
components:
  button-upload:
    backgroundColor: "#2c342f"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    height: "62px"
    padding: "0 27px"
---

# Moonwalk Homepage Design

## Overview
Scope: the upload homepage only. The assessment and authentication screens retain their existing styles. The user explicitly rejected a static upload card and requested the spatial, animated craft of Taste Skill and Impeccable, choosing richer motion. The homepage expresses learning materials unfolding into questions, without adding a marketing step before upload.

## Colors
Warm-neutral paper and charcoal carry the interface. Yellow, coral and teal distinguish illustrative document content. Do not apply a monochromatic green wash to the page.

## Typography
Both homepage Moonwalk titles use the original Snell Roundhand / Brush Script MT / Segoe Script cursive stack at weight 700, restored at the user's request. Italiana remains self-hosted as Moonwalk Display for workflow step numbers. DM Sans is self-hosted for Latin body text; Chinese uses the platform Chinese sans-serif. Display sizes are fixed at responsive breakpoints: 144, 124, 100, 76 and 64 px. The large display face belongs only to the brand heading, never to controls.

## Layout
A full-width Three.js scene surrounds the centered upload action. The functional interface is semantic HTML above the canvas. Desktop uses five sheets; widths below 760 px use three smaller sheets above the upload action. The scene toolbar is centered in a reserved 128 px area below the core controls, preventing overlap with paper content and errors. The four-step workflow sits below it.

## Elevation & Depth
Curved paper meshes, bitmap page textures and soft offset shadows create depth. Pages contain explicitly labeled synthetic examples, never user uploads. Pointer parallax and slow motion belong to this scene, not every UI control.

## Shapes
Upload and segmented controls use 8 px outer corners. Example pages remain paper-shaped. There is no outer card around the upload workflow.

## Components
The upload button retains file picker, loading and disabled behavior. The full homepage accepts file drops. AI selection uses pressed buttons and locks during processing. Material/question tabs change only the illustrative scene, not assessment settings. Pause freezes the animation and ignores pointer updates. System reduced-motion preferences default to pause. Hidden/offscreen scenes stop requesting frames; unmount disposes graphics resources. WebGL failure leaves static examples and functional controls.

## Do's and Don'ts
- Keep upload usable before the lazy-loaded scene initializes.
- Keep example content clearly distinguished from actual generated questions.
- Preserve focus visibility, document limits, errors and retry actions.
- Do not reintroduce template-based PPT generation or change PPTX material parsing.
- Do not turn this homepage-specific visual treatment into a global assessment redesign without a separate request.
