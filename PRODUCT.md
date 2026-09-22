# Moonwalk

## Platform
Web application. Chinese interface, desktop and mobile browsers.

## Product Truth
Students revising course materials and people completing training upload one PDF, DOCX or PPTX. The app identifies the document, lets the user confirm its summary, then generates a knowledge test or open-ended critical-reading questions. Users answer and review explanations. Files are temporary. Existing authentication, provider selection and assessment behavior must be preserved.

## Homepage
The primary action is uploading learning material, with an AI provider selected before entering the workflow. DeepSeek is the default; GPT is optional. No template-based presentation generation product remains. PPTX is still supported as learning material.

## Confirmed Design Brief
The user rejected the static centered upload card and a color-only refinement. They supplied tasteskill.dev and impeccable.style as visual quality references, and explicitly chose stronger visual impact with richer first-screen animation. Keep a light surface and the Moonwalk identity, and create a spatial scene in which documents unfold into summaries and questions. Upload and provider selection stay directly available. Respect reduced-motion preferences and provide animation pause.

## Stack
Existing React, TypeScript, Vite, plain CSS, lucide-react and Express. Scope the redesign to the homepage without changing the assessment logic.
