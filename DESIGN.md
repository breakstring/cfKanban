---
name: cfKanban
status: frozen
revision: 9
frozen_on: 2026-08-29
revised_on: 2026-10-01
selected_direction: nuxt-ui-kanban-workbench
applies_to:
  - first-party-web-ui
  - public-instance-home
  - browser-launch-and-auth
  - project-board-and-issue-detail
  - owner-maintenance
tokens:
  color:
    canvas: "#FFFFFF"
    surface: "#FFFFFF"
    surface-muted: "#F5F7F9"
    text: "#243247"
    text-muted: "#596B83"
    border: "#DCE3EC"
    border-strong: "#A5B3C5"
    primary: "#C2410C"
    primary-hover: "#9A3412"
    primary-pressed: "#7C2D12"
    focus: "#C2410C"
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
    control: "8px"
    card: "9px"
    column: "12px"
    overlay: "12px"
    pill: "999px"
  themes:
    orange:
      primary: "#C2410C"
      primary-hover: "#9A3412"
      primary-pressed: "#7C2D12"
      focus: "#C2410C"
      primary-soft: "#FFF3E9"
      surface-muted: "#F5F7F9"
      border: "#DCE3EC"
    blue:
      primary: "#1D4ED8"
      primary-hover: "#1E40AF"
      primary-pressed: "#1E3A8A"
      focus: "#1D4ED8"
      primary-soft: "#EFF6FF"
      surface-muted: "#F3F6FB"
      border: "#D9E2F0"
---

# cfKanban Design Contract

This document is the visual and interaction design source of truth for the first-party cfKanban Web UI. It turns the selected visual direction into rules that an Agent can apply and a reviewer can test.

- Product behavior, permissions, security, and recovery remain defined by the [Web UI SPEC](docs/specs/2026-08-29-web-ui-spec.md) and the API/Foundation contracts.
- If this file conflicts with a security, accessibility, or product contract, the stricter contract wins.
- `Frozen` means the selected direction, hierarchy, and current tokens are the implementation baseline. Exact values may only be revised with visual or accessibility evidence and an explicit contract revision.

## 1. Design intent

cfKanban is a simple, efficient Kanban workbench. Clear Issue hierarchy, predictable controls, and quick scanning take priority over decoration. All authenticated pages use Nuxt UI components within the existing Vue 3 + TypeScript + Vite application; this does not introduce Nuxt SSR or change the Worker deployment topology. The 2026-10-01 user authorization permits the framework's component conventions to replace conflicting earlier visual rules while preserving product semantics, security, and accessibility.

This revision applies to the Board, Issue detail and creation, profile, project selection, work lists, activity, labels, deleted items, scoped management, and all Owner pages. The public homepage keeps its existing hero, highlights, video and joining flow; CFK-534 adjusts only the header/footer and necessary canvas isolation. The documentation site keeps its existing layout. The two authenticated themes share exactly the same layout and interactions.

The following four-screen set records the earlier warm editorial direction. It remains useful for the unchanged public homepage and historical comparison; it is not the current authenticated layout or Nuxt UI implementation evidence:

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
2. **Neutral foundations.** White surfaces and quiet slate neutrals support either theme without illustration, texture, gradients, or ornamental effects.
3. **One primary action.** A task region has one clear primary action in the selected theme accent. Supporting actions use text, outline, or menus.
4. **Structure before containers.** Use spacing, alignment, typography, and dividers before adding backgrounds, borders, or elevation.
5. **Dense enough, never cramped.** Metadata is compact, while titles and action targets remain easy to scan and operate.
6. **Behavior is visible.** Saving, read-only state, conflicts, quota failures, and session expiry are explicit and never communicated by color alone.

## 2. Visual foundations

### 2.1 Color

The YAML tokens above define the authenticated application palette. Implement semantic CSS custom properties, for example `--color-canvas` and `--color-primary`, and map Nuxt UI semantic colors to the same theme. The unchanged public homepage keeps its warm canvas and original palette in its own scope.

- `canvas` is the default full-page background.
- `surface` is used for issue records, inputs, menus, dialogs, and other true foreground objects.
- `surface-muted` is reserved for selected navigation, disabled areas, and subtle grouping. It is not a default wrapper for every section.
- `primary` is reserved for the screen's primary action, active focus/selection, and links that need clear affordance.
- Semantic colors must always include text, an icon, or another non-color signal.
- Status columns do not receive five competing brand colors. Fixed status names and position carry the main status meaning.

Offer `orange` (Warm orange / 暖橙) as the default and `blue` (Calm blue / 静蓝) as the second theme. Only accent colors, related muted tints, and color states vary; spacing, typography, geometry, navigation, control placement, and interaction remain identical. Semantic danger, warning, and success retain their meaning in both themes. Labels may use accessible muted tints without turning a card into a rainbow.

The profile page presents the two named choices and an explicit Save action. The Principal preference is persisted by the server through the same self-profile API available to Agents. Apply the saved value throughout authenticated pages, including management; a new or unauthenticated Principal uses `orange`. Do not use browser-local identity or credentials to persist the theme, and do not silently change a saved theme to match the operating system.

### 2.2 Typography

Use system fonts only so the Worker serves no third-party font dependency. Icons are bundled locally; do not call a remote icon or font service at runtime.

```css
--font-ui: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
  "Segoe UI", sans-serif;
--font-display: ui-serif, Georgia, Cambria, "Times New Roman", serif;
--font-mono: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
```

- UI text, forms, menus, board columns, card titles, and Markdown body use `--font-ui`.
- Authenticated page titles use `--font-ui` in both locales. The public homepage may retain its existing restrained display face; under `:lang(zh-CN)`, use `--font-ui` to avoid unpredictable CJK serif fallback.
- `CFK-<number>`, versions, request IDs, and short machine metadata may use `--font-mono`.
- Body text: 14–16px; compact metadata: 12–13px; control labels: at least 14px.
- Project page title: 28–32px desktop, 24–28px narrow viewport.
- Use no more than two font families in one visible region. Monospace metadata does not count as a decorative third voice.
- Markdown reading width should not exceed approximately 65 characters per line when the detail layout permits it.

### 2.3 Spacing, shape, and elevation

- Use the 4px spacing scale from the YAML tokens. Prefer `8 / 12 / 16 / 24 / 32px` for most layout decisions.
- Controls are normally 36–40px high on desktop and at least 44px where touch is the primary input.
- Use `8px` control radius, `9px` card radius, and `12px` column/overlay radius. Pills are limited to compact tags, counts, status summaries, and avatars.
- Cards use a light boundary; one subtle shadow is allowed when needed to separate white cards from quiet column backgrounds. Do not add multiple elevation tiers.
- Menus and dialogs may use one restrained shadow plus a border. There are no multiple elevation tiers for ordinary content.
- Avoid large rounded shells around the whole application, cards inside cards, and floating dashboard tiles.

### 2.4 Brand mark

- The cfKanban mark is a warm-paper board with warm-ink task cards and one vivid-orange task card moving out of it: the board identifies the product, while the escaping card gives the Agent-first promise a small, playful motion cue. The rounded board has a transparent exterior. This light board replaces the black tile (CFK-415); a fully transparent board would lose the old white cards on light browser chrome. The mark uses a brighter orange than controls; interactive surfaces use the deeper accessible orange tokens above so white text and focus cues retain sufficient contrast.
- Use the same self-hosted mark for the favicon, public wordmark, authenticated header, and compact footer lockup. Keep adjacent `cfKanban` text as live text rather than baking a wordmark into the image.
- The source is `apps/web/src/assets/cfkanban-mark.png`. The plugin's `interface.composerIcon`, `logo`, and `logoDark` reference this same PNG, which is also included in the Skill bundle. Use the same artwork in both host themes; do not maintain a separate plugin copy.
- The mark must remain legible at 16px and 32px, keep its colored details within one warm-orange family, load no third-party resource, and carry an empty alt value when adjacent text already names the product.

## 3. Application shell

### 3.0 Authenticated account navigation

- The right side of the authenticated header contains only the independent language switch and one account-menu trigger. Keep workspace/project navigation in its existing scope area.
- The account menu groups the current name and role with Work list, Management center when permitted by the current Session, Personal settings, and Sign out. These items use the existing destinations and permissions; opening the menu does not expand access. Session expiry and the recommended address belong in the application footer.
- Use the same account menu on desktop and narrow screens. Keep sign-out explicit inside the menu; do not duplicate it in a separate session row. Long identity names wrap or truncate with their full accessible name retained.
- The trigger and menu support keyboard operation, visible focus, and touch. Escape closes the menu and returns focus to the trigger. The current name and role remain readable without competing with the current work surface.

### 3.1 Project Board

- Use a full-width application surface with a compact top bar and a quiet project header.
- Group the Project title and the primary `New issue` action on the first row, with the project description directly under its title. Search and compact priority/label menus share a quieter utility row. One secondary `Project settings` button opens the project-level page; do not repeat separate management, labels, activity, or deleted-Issue buttons on the Board. Filter selections apply immediately after a short debounce; search retains an explicit submit control in addition to Enter. This hierarchy follows the user's 2026-09-29 review of the expanded toolbar and filter rows.
- Do not add a persistent left sidebar to the default Board. Workspace/Project scope, search, and the single primary `New issue` action fit in the top region; identity details and account actions stay in the account menu, alongside an independent language switch.
- At a 1440px desktop viewport, all five fixed columns should be visible without reducing card text below the typography rules.
- Columns retain enough width for readable titles and metadata. At narrow viewports use horizontal board scrolling rather than compressing five columns into unreadable slivers; the five-column desktop fit and touch targets take priority over an arbitrary fixed minimum.
- When the five columns need to scroll, keep that overflow inside a named, keyboard-focusable Board region and show a concise localized cue that all five columns continue sideways. The status selector in each writable card's metadata row is the non-drag alternative and therefore uses a touch target of at least 44px on narrow viewports.
- Column separation uses spacing and a quiet slate-tinted background with 12px corners. Columns are not elevated panels.
- Issue cards do not repeat a completion-note action; optional completion notes belong in Issue detail.
- The column footer does not repeat `Add issue` when the top-level `New issue` action is already visible.

#### Project settings

- Use one shared `Project settings` page heading and tab navigation across Management, Labels, Activity, and Deleted issues. Management appears only for current server-confirmed Project management actions; Labels and Activity retain read access, label edits require effective writer access, and Deleted issues requires effective writer access.
- The Board entry selects Management for users who can manage this Project and Activity otherwise. Switching tabs preserves the current Project and the submitted Board filters used by Return to board. Do not fetch hidden tabs or enlarge Session scope.
- Retain existing management, labels, activity, and deleted-Issue URLs as direct tab entries. Workspace-level management remains a separate page, without Project tabs. Permissions, pagination, CAS, restoration, and event visibility remain unchanged. For an archived Project, show only an authorized Management tab and replace Return to board with Choose project (`/app`); do not send the user to an unavailable archived Board.

### 3.2 Issue cards

The visual order is:

1. `CFK-<number>` and priority on a compact top row;
2. the issue title as the main detail entry;
3. a compact summary of labels or exceptional markers, only when present;
4. assignee or `Unassigned`, with writable quick assignee and status controls in a quiet footer.

- Cards use `surface`, a light boundary, 9px radius, and compact spacing on the 4px scale. Keep title, labels, and assignee readable without a fixed card height. Long titles, labels, and exceptional markers may increase height.
- Show at most three label chips and a `+N` count for additional labels. The summary stays on one line when possible; long chips truncate without splitting ordinary characters, with full names in accessible text and titles. Issue detail retains all labels. Do not reserve a summary row when labels and exceptional markers are absent.
- A subtle divider may separate the assignee/status footer. Preserve explicit `Unassigned` text; long assignee names may truncate with the full name in the title. Allow metadata to wrap when necessary.
- Priority, assignee, and status retain transparent resting surfaces and a 32px minimum desktop height. The detail entry and all selectors use at least 44px below or at 940px viewport width. Keep selectors outside the detail button and isolate their pointer, keyboard, and drag events; saving disables all selectors and dragging.
- A card title normally occupies no more than two lines on the board, with its complete text retained in the accessible detail entry and title. Full content belongs in Issue detail.
- Empty columns remain visually quiet. Do not fill them with a permanent dashed drop box; show a drop target only during an active drag.
- `saving` disables repeated movement of the same card and shows a compact progress cue.
- Conflict or failure returns the card to the server-confirmed column and presents a nearby, readable explanation.
- Dragging has an equivalent keyboard/menu status action. Drop targets must not rely on color alone.

### 3.3 Issue detail and Markdown

- Keep editing and rendered reading modes visually distinct without introducing a WYSIWYG toolbar.
- Text fields use explicit `Save`; status changes and the dedicated priority selectors save their single explicit choice immediately as defined by the Web UI SPEC.
- Markdown rendering uses the same typography and theme surfaces. Code blocks use `--font-mono`, a muted surface, and horizontal scrolling rather than page overflow.
- Comments are a single chronological stream with light row separation. Do not wrap every comment in an elevated card.
- Completion comments are visually recognizable as immutable records but remain part of the same comment stream.
- The title region includes a compact status, priority, and assignee summary. At tablet widths the property rail remains beside the description; below 780px it follows the reading column, with an explicit `View properties` anchor in the summary.
- The property rail groups status and a named assignee selector (including Unassigned), followed by one completion action. Completion opens one optional-note dialog. Blocker flags, reasons, and manual actions are temporarily hidden under CFK-430; dependency relations remain available; no raw Principal ID input or redundant self-assignment button.
- Issue deletion stays a tertiary text action until the confirmation dialog. Comment deletion also recedes within its activity row.
- Attachments occupy their own section between description and activity. The file picker and single-file drop target share one calm surface; upload progress and retry remain local to the selected file. Use verified image thumbnails, readable file names and sizes, and explicit download/delete/restore actions. No R2 capability yields a short local explanation, never a page-level failure.

### 3.4 Owner maintenance

- Owner and scoped-management pages use the same Nuxt UI components, shell, and selected Principal theme as participant pages. Project selection, work lists, activity, labels, deleted items, and profile follow this same system.
- Use simple lists, tables, forms, and compact summaries for Overview, Workspaces/Projects, Access, and Audit.
- Workspace project rows vertically center the name and its management actions. Long names wrap completely, including unbroken names; actions retain their click targets and may wrap without overlapping the name. Form rows keep their own input alignment.
- Avoid metric tiles unless a value is both actionable and required by the product contract. Health and quota summaries should read as operational facts, not an analytics dashboard.
- Invitation history is reached from Access through a dedicated link and shows a bounded page with previous/next controls. Daily browsing stays separate from the full safety review needed for uncertain Invitation operations.
- Destructive or security-sensitive actions use explicit labels and confirmation copy; red is not used as general decoration.
- Overview uses the already-loaded Workspace inventory as a short list of direct entry points, alongside two simple navigation rows for members/invitations and activity. Choosing a Workspace opens the existing maintenance view with that Workspace expanded. It does not load additional Projects or Issues before the user chooses a destination.
- Service versions, origins, and rate limits remain available in a disclosure below daily navigation. Do not fill unused space with invented analytics, activity, or decorative tiles.

### 3.5 Public and authentication pages

- Public pages use a centered reading column on the same warm canvas, not a boxed application mockup.
- The copyable Agent instruction is the visual primary content on the public home page.
- The public-home headline uses exactly two intentional lines per locale. Each line stays intact rather than accepting an arbitrary browser wrap; its responsive type size must fit a 320px viewport without horizontal overflow. English and Simplified Chinese may use different sizes because their glyph widths differ.
- The Agent instruction card gives the short copyable prompt, one concise Node.js / Wrangler / Cloudflare preparation sentence, and a direct guide link. Keep it balanced with the hero copy; service and cost explanations belong in the highlights below. It must not send the Agent to a general README and ask it to infer the deployment workflow.
- Between the hero and product video, show three equal editorial columns for Agent-first operations, deployment within Cloudflare free allowances, and workspace/project permissions. Use live bilingual text and thin dividers, without cards, extra calls to action, or decorative images. Stack the columns with horizontal dividers on narrow screens. Free-tier wording stays bounded by allowances, with R2 attachments and paid capacity explicitly optional.
- The public home has four compact scroll stages: hero/deployment guide below the header, highlights, video, then Public Join and footer. Keep the header sticky and account for its height at snap targets; the footer stays in normal flow. Use bounded whitespace so the next stage can appear in the viewport, with native proximity snapping and normal document scrolling. Content may grow, including project lists and copy recovery; keep recovery near its action and do not intercept wheel, touch, or keyboard events. Disable snapping for reduced-motion preferences, and scope it to the public home so authenticated pages retain their normal scrolling.
- Public Join Project choices are a simple list or grid of records with a clear `reader | writer` choice. Do not market them as pricing tiers.
- The public home ends with an understated product footer separated by one rule. It contains the wordmark/tagline, deployment and joining guides, API contract, source link, Service version, and a shortened Instance ID; it does not grow into a sitemap, marketing panel, decorative date, or second navigation shell. CFK-534 keeps the warm canvas across the entire public page, including the body, sticky header, and footer; the global UI framework must not turn the surrounding body white. Header/footer content and their rules share the existing page width and responsive gutters. Keep one footer boundary, allow metadata and links to wrap, and keep narrow-screen link targets at least 44px high. Scope these styles to the public home.
- Authenticated pages share a compact footer with the product mark/version, localized same-instance documentation, GitHub, and Session expiry. Show `Signed in until [localized date and time]` / `登录有效至 [本地化日期时间]`, followed by `After expiry, sign in with a Passkey or ask your Agent to reopen.` / `到期后请用通行密钥重新登录，或让 Agent 重新打开。` These lines describe the existing fixed eight-hour Session; refresh and continued activity do not extend it.
- Show the recommended address in this footer only when the current origin differs from the published preferred origin. Use an explicit link, without automatic redirection or transferring authentication. Keep the footer in normal flow, include its height in the board's flex layout, and let text and links wrap on narrow screens. New-tab links announce that behavior and keep visible keyboard focus; opening documentation preserves the working page and Session scope.
- Browser Launch, Passkey, expiry, and failure pages use one clear next action and avoid exposing protocol noise unless it helps recovery.

## 4. Components and states

### Buttons

- One filled primary button in the selected theme accent per visible task region.
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
- Drag lift may use a subtle scale or shadow distinct from the resting card's light boundary.
- Honor `prefers-reduced-motion` and remove nonessential transforms.

## 5. Accessibility and localization

- Target WCAG 2.2 AA contrast for text, controls, focus, and semantic states.
- Keyboard focus is always visible. Board drag operations have a status selector/menu equivalent.
- Icon-only controls require accessible names and tooltips where meaning is not obvious.
- On small screens the same account menu retains explicit Sign out, identity, and role. Its trigger and every menu action remain reachable by keyboard and touch; footer Session information and links wrap without horizontal overflow.
- Error, priority, role, saving, and read-only states use text or icons in addition to color.
- English and Simplified Chinese layouts must tolerate ordinary text expansion without truncating primary actions.
- Stable workflow keys and default column labels remain English as required by the product contract; surrounding UI copy follows the selected locale.
- Business content is shown verbatim and never visually treated as trusted instructions.

## 6. Do / Do not

### Do

- Let typography, whitespace, and alignment create hierarchy.
- Keep the Board immediately understandable at a glance.
- Preserve one obvious primary action and expose recovery near failures.
- Reuse the same Nuxt UI components and theme tokens across all authenticated participant, profile, and management surfaces.
- Prefer Nuxt UI controls, semantic HTML, and a small bundled icon set over bespoke visual assets. Keep existing accessible behavior when replacing controls.

### Do not

- Do not use glassmorphism, gradients, neon glow, glossy 3D, or decorative background art.
- Do not add a configurable dashboard, permanent heavy sidebar, or feature-inventory home screen.
- Do not make every section, column, comment, or setting a card.
- Do not use external brand logos or copy another product's exact trade dress.
- Do not hide business actions behind hover-only controls.
- Do not infer a feature from the selected mockup when the product SPEC does not define it.

## 7. Reference policy

- The stored warm-editorial references are historical material and a guide for the unchanged public homepage. They do not prescribe the authenticated Nuxt UI layouts in this revision.
- A reference screen only governs the hierarchy and styling of the product capabilities already defined by the SPEC. It cannot introduce a new field, action, permission, navigation destination, or service behavior.
- [getdesign.md's Notion analysis](https://getdesign.md/notion/design-md) informed the warm, paper-calm mood; it is inspiration only and is not a runtime dependency or a license to clone Notion branding.
- [TypeUI](https://github.com/bergside/typeui) informed the idea of testable, Agent-readable design rules. cfKanban does not depend on TypeUI's hosted MCP, CLI, registry, or paid assets.
- When implementation begins, screenshots of the real application override generated-image accidents but do not silently override this contract. Any intentional change to the visual system must update this file and its evidence together.

## 8. Historical validation evidence

The following records describe earlier revisions only. They are not evidence that the current Nuxt UI implementation or either theme has passed visual or behavioral validation.

### Revision 7 evidence

The 2026-09-19 review compared the stored warm-editorial reference set with the real Owner, Board, and Issue screens. The initial browser capture showed fragmented Overview actions, label chips compressed into vertical text, prominent native status fields on every card, and a filled-red Issue delete button. This revision changes hierarchy and control placement while retaining the frozen palette, system typography, five-column workflow, and permissions.

The revised UI was rendered in the Codex in-app browser against an isolated local Worker/D1/R2 fixture. The visual comparison covered the Owner overview, a 1440px five-column Board, a 390px horizontally scrolling Board, and Issue detail at 1440px and 390px. Source reference images and actual before/after captures were inspected with `view_image` in the same review. Attachment upload, verified image preview, soft deletion, and restoration were exercised in that local fixture. The fixture supplies example content only; it is not evidence of production authentication or production data.

| Comparison | Evidence and resulting rule |
| --- | --- |
| Information hierarchy | Overview now groups real Workspace navigation with member/activity entry points instead of scattering three unrelated buttons across empty space. |
| Card anatomy | Labels remain horizontal; assignee and status share a footer. At 1440px all five columns remain visible, with readable titles and no raised column shells. |
| Typography and palette | Page headings remain restrained system serif in English and sans in Chinese; warm neutrals and the accessible deep-orange action color remain unchanged. |
| Detail and destructive actions | Status, priority, and assignee are available before the body; deletion becomes red only in the explicit confirmation. |
| Narrow layout and controls | At 390px overflow belongs to the named Board region. Touch controls remain at least 44px tall; the property shortcut and sign-out action stay available. |
| Attachment placement | Upload and recovery live immediately after the description. File rows use a small verified preview or file mark, readable filename and size, with download and recovery controls alongside. Mobile screenshots exposed excess vertical space in compact section headings; those headings retain a left title and right action/count. |
| Copy inventory | Existing business content and default workflow names are unchanged. Intentional additions are the search submit label, property shortcut, brief Overview navigation descriptions, and attachment copy required by the new attachment SPEC; each has English and Chinese text. |

Generated reference artwork remains a mood and hierarchy guide. No avatars, fake counters, decorative dates, extra columns, or unsupported controls were introduced from it.


### 2026-09-20 Issue 操作与邀请历史验证

本次延续现有 tokens，用名称选择器替换详情页的重复指派按钮和 UUID 输入；完成操作合并为一个选填说明弹窗，卡片不再重复显示说明入口。阻塞原因与前置关系说明独立呈现，看板提供服务端阻塞筛选。邀请历史按需进入独立页面，普通分页与完整安全复核使用独立状态。

本次按用户要求以桌面与 IAB 常见半屏为主要验收基准，不扩大窄屏专项范围。Web 保持低频查看、确认和手动调整，日常执行以 Code Agents 为主。

本地 Vite + Playwright/Chrome 模拟 API 验证覆盖 1440×1000、800×1000、720×1000，另已做 390×844 基本检查：候选分页、切换/取消指派及同值不写入，完成取消/空摘要/reopen，人工阻塞解除与依赖阻塞区别，看板筛选与无重复卡片按钮，人员页不加载邀请、历史上下页替换数据和按需安全复核。检查无横向页面溢出、空页面、框架错误或控制台错误。Worker 权限和分页由独立本地 D1 集成测试验证；浏览器截图使用测试内容，不代表生产发布或认证验收。
