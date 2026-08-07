# Windows Toolbar App Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display the existing application icon inside the reserved left side of the main toolbar on Windows while preserving the macOS traffic-light spacing.

**Architecture:** Expose a read-only desktop platform value through the existing context-isolated preload bridge, then conditionally render the bundled application icon inside the existing `56px` toolbar spacer only when the renderer is running on Windows. Cover the behavior with a real Electron E2E assertion and capture a screenshot from the current workspace build for user approval before the production changes are committed.

**Tech Stack:** TypeScript 7, React 19, Electron 43, Tailwind CSS 4, Playwright Electron E2E.

## Global Constraints

- Reuse `src/assets/icon.png`; do not add a duplicate image.
- Show the icon only when the platform is `win32`.
- Keep the existing `56px` left toolbar container on every platform.
- Render the Windows icon at exactly `36 × 36px`.
- Keep macOS traffic-light spacing unchanged.
- Keep Linux behavior unchanged.
- Do not add IPC, Node.js access in the renderer, click behavior, borders, backgrounds, or new dependencies.
- Build and launch the current workspace version for the preview, never the separately installed application.
- Do not stage or restore `e2e/screenshots/example.png`.
- Do not commit production changes until the user approves the GUI preview.

---

### Task 1: Expose and render the Windows toolbar icon

**Files:**
- Modify: `src/types/electron-api.ts`
- Modify: `electron/preload/index.ts`
- Modify: `src/layouts/default.tsx`
- Modify: `e2e/example.spec.ts`

**Interfaces:**
- Produces:

```ts
export type DesktopPlatform = "win32" | "darwin" | "linux";

export interface ElectronAPI {
  platform: DesktopPlatform;
  // existing methods remain unchanged
}
```

- Consumes:
  - `process.platform` in the Electron preload.
  - Existing `src/assets/icon.png`.
  - Existing `window.electronAPI` context bridge.

- [ ] **Step 1: Write the failing Windows Electron E2E test**

Add a test after the existing homepage test in `e2e/example.spec.ts`:

```ts
test("Windows toolbar fills the traffic-light spacer with the app icon", async () => {
  test.skip(process.platform !== "win32", "Windows-specific toolbar layout");

  const app = await electron.launch({ args: [".", "--no-sandbox"] });
  try {
    const page = await app.firstWindow();
    const icon = page.getByTestId("windows-toolbar-app-icon");

    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute("alt", "");
    await expect(icon).not.toHaveAttribute("role", "button");
    await expect
      .poll(() =>
        icon.evaluate((element) => {
          const image = element as HTMLImageElement;
          const bounds = image.getBoundingClientRect();
          return {
            width: bounds.width,
            height: bounds.height,
            loaded: image.complete && image.naturalWidth > 0,
          };
        })
      )
      .toEqual({ width: 36, height: 36, loaded: true });

    await expect(page.getByText("Subtitle Translator", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add task" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 2: Build the unchanged application and verify RED**

Run:

```powershell
npm run pree2e
npx playwright test e2e/example.spec.ts --grep "Windows toolbar fills"
```

Expected: FAIL because `windows-toolbar-app-icon` does not exist.

- [ ] **Step 3: Add the typed platform field**

In `src/types/electron-api.ts`, export:

```ts
export type DesktopPlatform = "win32" | "darwin" | "linux";
```

Add to `ElectronAPI`:

```ts
platform: DesktopPlatform;
```

In `electron/preload/index.ts`, import `DesktopPlatform` and add:

```ts
platform: process.platform as DesktopPlatform,
```

This is a read-only primitive copied through the context bridge. Existing preload methods remain unchanged.

- [ ] **Step 4: Conditionally render the existing icon**

In `src/layouts/default.tsx`, import:

```ts
import appIcon from "@/assets/icon.png";
```

Replace the empty spacer with:

```tsx
<div
  className="flex w-14 shrink-0 items-center justify-center"
  aria-hidden="true"
>
  {window.electronAPI.platform === "win32" && (
    <img
      src={appIcon}
      alt=""
      data-testid="windows-toolbar-app-icon"
      draggable={false}
      className="pointer-events-none size-9 select-none object-contain"
    />
  )}
</div>
```

Do not apply the no-drag style to the container or image; it remains part of the header drag region.

- [ ] **Step 5: Rebuild and verify GREEN**

Run:

```powershell
npm run pree2e
npx playwright test e2e/example.spec.ts --grep "Windows toolbar fills"
npm run typecheck
```

Expected: the Windows E2E test and both TypeScript configurations pass.

---

### Task 2: Capture and review the real Windows GUI

**Files:**
- Create preview artifact outside the repository source tree:
  `C:\Users\kfore\Documents\Codex\2026-07-27\qing\artifacts\windows-toolbar-app-icon-preview.png`

**Interfaces:**
- Consumes:
  - Task 1 test build in `dist` and `dist-electron`.
  - Existing isolated E2E user-data mechanism.
- Produces:
  - One PNG screenshot showing the complete Windows application window.

- [ ] **Step 1: Launch the workspace Electron build**

Launch Electron with:

```text
args: [".", "--no-sandbox"]
```

Set `SUBTITLE_TRANSLATOR_E2E_USER_DATA` to a fresh temporary directory so the preview cannot use the installed application profile.

- [ ] **Step 2: Prepare a stable preview state**

In the workspace application page:

```ts
localStorage.clear();
localStorage.setItem("language", JSON.stringify("zh-CN"));
```

Reload and wait for the Chinese “新增任务” and “设置” buttons to become visible.

- [ ] **Step 3: Capture the complete application window**

Save a full-page screenshot to:

```text
C:\Users\kfore\Documents\Codex\2026-07-27\qing\artifacts\windows-toolbar-app-icon-preview.png
```

Inspect the image locally to confirm:

- the icon is loaded;
- the visual icon is centered inside the original left spacer;
- the title has not moved;
- the right-side buttons are not displaced;
- the native Windows title bar remains visible and functional.

- [ ] **Step 4: Present the screenshot and pause**

Show the screenshot to the user and ask for visual approval. Do not commit Task 1 production or E2E files before approval.

---

### Task 3: Final regression and commit after visual approval

**Files:**
- Verify: `src/types/electron-api.ts`
- Verify: `electron/preload/index.ts`
- Verify: `src/layouts/default.tsx`
- Verify: `e2e/example.spec.ts`

**Interfaces:**
- Consumes Task 1 implementation approved through Task 2.
- Produces one local source commit without screenshot artifacts.

- [ ] **Step 1: Run the complete validation suite**

Run:

```powershell
npm run typecheck
npm run test
npm run e2e
git diff --check
```

Expected:

- both TypeScript configurations pass;
- all unit tests pass;
- all runnable Electron E2E tests pass;
- only platform-conditional tests may skip;
- `e2e/screenshots/example.png` remains unstaged.

- [ ] **Step 2: Inspect scope and security boundaries**

Confirm:

- no renderer Node.js access was added;
- only a primitive platform string crosses the preload bridge;
- no IPC or dependency was added;
- macOS and Linux retain their empty `56px` spacer;
- the preview PNG is outside the repository source changes.

- [ ] **Step 3: Commit only the approved source and test files**

Stage:

```text
src/types/electron-api.ts
electron/preload/index.ts
src/layouts/default.tsx
e2e/example.spec.ts
```

Commit:

```text
fix: fill Windows toolbar spacer with app icon
```
