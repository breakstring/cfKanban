---
name: cfKanban
status: frozen
revision: 5
frozen_on: 2026-08-29
revised_on: 2026-09-04
selected_direction: warm-editorial-workbench
applies_to:
  - first-party-web-ui
  - public-instance-home
  - browser-launch-and-auth
  - project-board-and-issue-detail
  - owner-maintenance
tokens:
  color:
    canvas: "#FAF8F4"
    surface: "#FFFDF9"
    surface-muted: "#F3F0EA"
    text: "#20201F"
    text-muted: "#6C6861"
    border: "#DDD8CF"
    border-strong: "#BDB7AD"
    primary: "#2167D5"
    primary-hover: "#1857BB"
    primary-pressed: "#124794"
    focus: "#0B5FCC"
    danger: "#B42318"
    danger-soft: "#FCE8E6"
    warning: "#A15C00"
    warning-soft: "#FFF1D6"
    success: "#287A4B"
    success-soft: "#E5F3EA"
  spacing:
    1: "4px"
    2: "8px"
    3: "12px"
    4: "16px"
    6: "24px"
    8: "32px"
    12: "48px"
  radius:
    control: "6px"
    card: "8px"
    overlay: "10px"
    pill: "999px"
---

# cfKanban Design Contract

This document is the visual and interaction design source of truth for the first-party cfKanban Web UI. It turns the selected visual direction into rules that an Agent can apply and a reviewer can test.

- Product behavior, permissions, security, and recovery remain defined by the [Web UI SPEC](docs/specs/2026-08-29-web-ui-spec.md) and the API/Foundation contracts.
- If this file conflicts with a security, accessibility, or product contract, the stricter contract wins.
- `Frozen` means the selected direction, hierarchy, and current tokens are the implementation baseline. Exact values may only be revised with visual or accessibility evidence and an explicit contract revision.

## 1. Design intent

cfKanban should feel like a calm working ledger rather than a configurable enterprise dashboard. It is warm, direct, and readable enough for occasional human use while remaining compact enough for a five-column Kanban board.

The selected direction is represented by a four-screen reference set. Each image
tests the same visual language against a different product surface:

| Surface | Reference |
| --- | --- |
| Project Board | [Warm editorial Board](docs/design/references/cfkanban-board-warm-editorial.png) |
| Public instance home | [Warm editorial Public Home](docs/design/references/cfkanban-public-home-warm-editorial.png) |
| Issue detail | [Warm editorial Issue Detail](docs/design/references/cfkanban-issue-detail-warm-editorial.png) |
| Owner maintenance | [Warm editorial Owner Overview](docs/design/references/cfkanban-owner-overview-warm-editorial.png) |

These screens are mood, density, and hierarchy references, not pixel contracts or
feature specifications. Generated accidents such as footer dates, duplicate add
controls, decorative avatars, or any element not supported by the product SPEC
must not become features.

### Principles

1. **Quiet chrome, clear work.** Issue content and current scope dominate; navigation and account controls recede.
2. **Warm, not decorative.** Warm neutrals replace clinical gray, but the UI does not use illustration, texture, gradients, or ornamental effects.
3. **One primary action.** A screen has one blue primary action. Supporting actions use text, outline, or menus.
4. **Structure before containers.** Use spacing, alignment, typography, and dividers before adding backgrounds, borders, or elevation.
5. **Dense enough, never cramped.** Metadata is compact, while titles and action targets remain easy to scan and operate.
6. **Behavior is visible.** Saving, read-only state, conflicts, quota failures, and session expiry are explicit and never communicated by color alone.

## 2. Visual foundations

### 2.1 Color

The YAML tokens above are normative. Implement them as CSS custom properties with the same semantic names, for example `--color-canvas` and `--color-primary`.

- `canvas` is the default full-page background.
- `surface` is used for issue records, inputs, menus, dialogs, and other true foreground objects.
- `surface-muted` is reserved for selected navigation, disabled areas, and subtle grouping. It is not a default wrapper for every section.
- `primary` is reserved for the screen's primary action, active focus/selection, and links that need clear affordance.
- Semantic colors must always include text, an icon, or another non-color signal.
- Status columns do not receive five competing brand colors. Fixed status names and position carry the main status meaning.

Do not introduce a second brand accent without revising this file. Labels may use a small set of accessible muted tints, but they must not turn a card into a rainbow.

### 2.2 Typography

Use system fonts only in v0 so the Worker serves no third-party font dependency.

```css
--font-ui: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
  "Segoe UI", sans-serif;
--font-display: ui-serif, Georgia, Cambria, "Times New Roman", serif;
--font-mono: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
```

- UI text, forms, menus, board columns, card titles, and Markdown body use `--font-ui`.
- The Latin product/project page title may use `--font-display` at a restrained weight. Under `:lang(zh-CN)`, use `--font-ui` for headings to avoid unpredictable CJK serif fallback.
- `CFK-<number>`, versions, request IDs, and short machine metadata may use `--font-mono`.
- Body text: 14–16px; compact metadata: 12–13px; control labels: at least 14px.
- Project page title: 28–32px desktop, 24–28px narrow viewport.
- Use no more than two font families in one visible region. Monospace metadata does not count as a decorative third voice.
- Markdown reading width should not exceed approximately 65 characters per line when the detail layout permits it.

### 2.3 Spacing, shape, and elevation

- Use the 4px spacing scale from the YAML tokens. Prefer `8 / 12 / 16 / 24 / 32px` for most layout decisions.
- Controls are normally 36–40px high on desktop and at least 44px where touch is the primary input.
- Use `6px` control radius and `8px` card radius. Pills are limited to compact tags, counts, status summaries, and avatars.
- Default surfaces are flat. Cards use a 1px `border` and no shadow.
- Menus and dialogs may use one restrained shadow plus a border. There are no multiple elevation tiers for ordinary content.
- Avoid large rounded shells around the whole application, cards inside cards, and floating dashboard tiles.

### 2.4 Brand mark

- The cfKanban mark is a warm-ink board with one vivid-orange task card moving out of it: the board identifies the product, while the escaping card gives the Agent-first promise a small, playful motion cue. Orange is the mark's expressive accent; it does not replace blue's semantic role for primary actions inside the product UI.
- Use the same self-hosted mark for the favicon, public wordmark, authenticated header, and compact footer lockup. Keep adjacent `cfKanban` text as live text rather than baking a wordmark into the image.
- The mark must remain legible at 16px and 32px, keep its colored details within one warm-orange family, load no third-party resource, and carry an empty alt value when adjacent text already names the product.

## 3. Application shell

### 3.1 Project Board

- Use a full-width application surface with a compact top bar and a quiet project header.
- Do not add a persistent left sidebar to the default Board. Workspace/Project scope, search, locale, session/role summary, profile, and the single primary `New issue` action fit in the top region.
- At a 1440px desktop viewport, all five fixed columns should be visible without reducing card text below the typography rules.
- Each column has a practical minimum width of 248px. Narrow viewports use horizontal board scrolling rather than compressing five columns into unreadable slivers.
- On narrow viewports, keep that overflow inside a named, keyboard-focusable Board region and show a concise localized cue that all five columns continue sideways. The status selector beneath each writable card is the non-drag alternative and therefore uses a touch target of at least 44px.
- Column separation uses spacing and a subtle vertical divider or surface step. Columns are not five large elevated cards.
- The column footer does not repeat `Add issue` when the top-level `New issue` action is already visible.

### 3.2 Issue cards

The visual order is:

1. `CFK-<number>` and priority metadata;
2. issue title;
3. labels or exceptional markers when present;
4. assignee or `Unassigned`.

- Cards use `surface`, a 1px border, 8px radius, and 12px padding.
- A card title normally occupies no more than three lines on the board. Full content belongs in Issue detail.
- Empty columns remain visually quiet. Do not fill them with a permanent dashed drop box; show a drop target only during an active drag.
- `saving` disables repeated movement of the same card and shows a compact progress cue.
- Conflict or failure returns the card to the server-confirmed column and presents a nearby, readable explanation.
- Dragging has an equivalent keyboard/menu status action. Drop targets must not rely on color alone.

### 3.3 Issue detail and Markdown

- Keep editing and rendered reading modes visually distinct without introducing a WYSIWYG toolbar.
- Text fields use explicit `Save`; only a Board status drop is saved immediately as defined by the Web UI SPEC.
- Markdown rendering uses the same typography and warm surfaces. Code blocks use `--font-mono`, a muted surface, and horizontal scrolling rather than page overflow.
- Comments are a single chronological stream with light row separation. Do not wrap every comment in an elevated card.
- Completion comments are visually recognizable as immutable records but remain part of the same comment stream.

### 3.4 Owner maintenance

- Owner pages use the same shell and tokens. They are not a separate admin theme.
- Use simple lists, tables, forms, and compact summaries for Overview, Workspaces/Projects, Access, and Audit.
- Avoid metric tiles unless a value is both actionable and required by the product contract. Health and quota summaries should read as operational facts, not an analytics dashboard.
- Destructive or security-sensitive actions use explicit labels and confirmation copy; red is not used as general decoration.

### 3.5 Public and authentication pages

- Public pages use a centered reading column on the same warm canvas, not a boxed application mockup.
- The copyable Agent instruction is the visual primary content on the public home page.
- The public-home headline uses exactly two intentional lines per locale. Each line stays intact rather than accepting an arbitrary browser wrap; its responsive type size must fit a 320px viewport without horizontal overflow. English and Simplified Chinese may use different sizes because their glyph widths differ.
- The Agent instruction card gives the short copyable prompt, one sentence explaining the dedicated guide, and a direct guide link. It must not send the Agent to a general README and ask it to infer the deployment workflow.
- Public Join Project choices are a simple list or grid of records with a clear `reader | writer` choice. Do not market them as pricing tiers.
- The public home ends with an understated product footer separated by one rule. It contains the wordmark/tagline, deployment and joining guides, API contract, source link, Service version, and a shortened Instance ID; it does not grow into a sitemap, marketing panel, decorative date, or second navigation shell.
- Browser Launch, Passkey, expiry, and failure pages use one clear next action and avoid exposing protocol noise unless it helps recovery.

## 4. Components and states

### Buttons

- One filled blue primary button per visible task region.
- Secondary actions are neutral outline buttons; tertiary actions are text buttons or menu items.
- Destructive actions are not filled red by default. Use a red treatment only at the final, explicit destructive step.
- Every button has default, hover, focus-visible, active, disabled, and loading states.

### Inputs

- Inputs use a white surface, 1px border, and visible label. Placeholder text never replaces the label.
- Focus uses a 2px `focus` ring with sufficient offset from the border.
- Validation copy appears beside the affected field and names a recovery action when possible.

### Tags and badges

- Tags are compact supporting metadata, never the main hierarchy.
- Priority uses text plus semantic color. `High` and `Medium` must remain distinguishable without color.
- Role and read-only state are plain language, not unexplained initials.

### Dialogs and menus

- Use a dialog only when the user must complete or confirm a bounded task before continuing, such as providing a completion summary.
- Do not use nested dialogs.
- Menus contain secondary actions; the screen's primary action stays visible.

### Motion

- Interaction transitions are 120–180ms and explain state change rather than decorate the page.
- Drag lift may use a subtle scale or shadow, but the resting card remains flat.
- Honor `prefers-reduced-motion` and remove nonessential transforms.

## 5. Accessibility and localization

- Target WCAG 2.2 AA contrast for text, controls, focus, and semantic states.
- Keyboard focus is always visible. Board drag operations have a status selector/menu equivalent.
- Icon-only controls require accessible names and tooltips where meaning is not obvious.
- Error, priority, role, saving, and read-only states use text or icons in addition to color.
- English and Simplified Chinese layouts must tolerate ordinary text expansion without truncating primary actions.
- Stable workflow keys and default column labels remain English as required by the product contract; surrounding UI copy follows the selected locale.
- Business content is shown verbatim and never visually treated as trusted instructions.

## 6. Do / Do not

### Do

- Let typography, whitespace, and alignment create hierarchy.
- Keep the Board immediately understandable at a glance.
- Preserve one obvious primary action and expose recovery near failures.
- Reuse the same tokens and components across public, participant, and Owner surfaces.
- Prefer CSS, standard controls, and a small icon set over bespoke visual assets.

### Do not

- Do not use glassmorphism, gradients, neon glow, glossy 3D, or decorative background art.
- Do not add a configurable dashboard, permanent heavy sidebar, or feature-inventory home screen.
- Do not make every section, column, comment, or setting a card.
- Do not use external brand logos or copy another product's exact trade dress.
- Do not hide business actions behind hover-only controls.
- Do not infer a feature from the selected mockup when the product SPEC does not define it.

## 7. Reference policy

- The selected reference set is stored in-repository so future Agents can inspect the same visual system across public, participant, Board, Issue, and Owner contexts.
- A reference screen only governs the hierarchy and styling of the product capabilities already defined by the SPEC. It cannot introduce a new field, action, permission, navigation destination, or service behavior.
- [getdesign.md's Notion analysis](https://getdesign.md/notion/design-md) informed the warm, paper-calm mood; it is inspiration only and is not a runtime dependency or a license to clone Notion branding.
- [TypeUI](https://github.com/bergside/typeui) informed the idea of testable, Agent-readable design rules. cfKanban does not depend on TypeUI's hosted MCP, CLI, registry, or paid assets.
- When implementation begins, screenshots of the real application override generated-image accidents but do not silently override this contract. Any intentional change to the visual system must update this file and its evidence together.
