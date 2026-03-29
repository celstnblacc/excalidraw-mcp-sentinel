---
name: excalidraw-skill
description: MANDATORY prerequisite for ALL Excalidraw MCP tool usage. Read this skill BEFORE calling any Excalidraw tool (batch_create_elements, create_element, create_from_mermaid, update_element, etc.) — without this skill's sizing formulas, two-batch ordering (shapes first, arrows second), and write-check-review verification cycle, diagrams will have invisible arrows, truncated text, and overlapping elements. Use whenever the user asks to draw, create, visualize, sketch, or diagram anything — flowcharts, architecture diagrams, system designs, org charts, sequence flows, decision trees, network topologies, ER diagrams, mind maps, or any visual on Excalidraw canvas. Also covers diagram refinement, PNG/SVG export, project/workspace management, and all canvas interactions.
---

# Excalidraw Skill

## Step 0: Detect Connection Mode

Run these checks **in order**:

1. **MCP Server** (best): If tools like `batch_create_elements` are available → use MCP mode.
2. **REST API** (fallback): `curl -s http://localhost:3000/health` returns `{"status":"ok"}` → use REST API mode.
3. **Nothing works**: Guide user to install (clone `celstnblacc/excalidraw-mcp-sentinel`, build, configure MCP).

See `references/cheatsheet.md` for the full MCP-vs-REST mapping and REST API gotchas.

## Step 1: Load User Preferences

Before creating any elements, load the user's diagram preferences. These control default font, roughness, stroke width, etc.

### Preference Resolution Order (most specific wins)

| Priority | Scope | Location | Persists |
|----------|-------|----------|----------|
| 1 (highest) | Session | In-memory (set via prompt during this conversation) | No — current session only |
| 2 | Folder | `.claude/excalidraw-preferences.json` in the current project root | Yes — per-project |
| 3 | Global | `~/.claude/skills/excalidraw-skill/preferences.json` | Yes — all projects |
| 4 (lowest) | Hardcoded | Server defaults (fontFamily: 5, roughness: 0, fontSize: 20, strokeWidth: 2) | — |

### How to Load

1. **Check folder-level first**: Read `.claude/excalidraw-preferences.json` from the current working directory (or project root). If it exists and has `defaults`, use those values.
2. **Fall back to global**: Read `~/.claude/skills/excalidraw-skill/preferences.json`. If it exists and has `defaults`, use those values.
3. **If neither exists** → run the **First-Time Setup** prompt below.
4. **Merge**: Folder preferences override global; global overrides hardcoded. Only override fields that are explicitly set.

### First-Time Setup (Interactive)

If no preferences file exists at either location, **prompt the user before drawing anything**:

> **Excalidraw Preferences Setup**
>
> I don't have any saved diagram preferences yet. Let me set up your defaults so every diagram looks the way you want.

Ask these questions (use `AskUserQuestion` tool if available, otherwise ask inline):

1. **Font family** — Which font for all text? _(IDs from `src/font-families.json`)_
   - Excalifont (hand-drawn) = 5
   - Helvetica (sans-serif) = 2
   - Cascadia (monospace) = 3
   - Comic Shanns = 8
   - Nunito = 6
   - Lilita One = 7

2. **Roughness** — Diagram style?
   - Clean/professional (roughness: 0) — recommended
   - Hand-drawn sketch (roughness: 1)
   - Very rough (roughness: 2)

3. **Scope** — Where to save?
   - **This session only** — don't save to disk, just use for this conversation
   - **This project** — save to `.claude/excalidraw-preferences.json` in project root
   - **Global (all projects)** — save to `~/.claude/skills/excalidraw-skill/preferences.json`

Then save the preferences JSON to the chosen location:

```json
{
  "defaults": {
    "fontFamily": <user_choice>,
    "fontSize": 20,
    "roughness": <user_choice>,
    "strokeWidth": 2
  }
}
```

For session-only scope, just hold the values in memory and apply them to every element in this conversation.

### Applying Preferences

Once loaded, apply `defaults` to **every element** that supports the property:
- `fontFamily` → all text-containing elements (text, rectangles with labels, diamonds, ellipses, arrows with labels)
- `fontSize` → text elements and labels (unless the element explicitly overrides it)
- `roughness` → all elements
- `strokeWidth` → arrows and lines

User-specified values in individual element calls always override preferences.

## Core Principles (Read Before Any Diagram)

These principles were learned through extensive iterative use. Violating them produces bad diagrams.

### 1. Never Trust Blind Output — Use the Write-Check-Review Cycle

Every diagram iteration follows this mandatory loop:

```
WRITE (create/update elements)
  → CHECK (screenshot to see actual rendering)
    → REVIEW (critically evaluate against Quality Checklist)
      → FIX (if issues found, fix and re-screenshot)
        → only proceed when ALL checks pass
```

**Screenshot strategy**: `get_canvas_screenshot` may return empty images. When it fails, use Chrome DevTools MCP (`take_screenshot` after `navigate_page` to canvas URL) as a reliable fallback.

### 2. Use batch_create_elements, Not Mermaid

The `create_from_mermaid` tool produces **low-quality output**: overlapping text, poor spacing, unreadable labels. It is a quick preview tool, not a production tool.

For quality diagrams, **always use `batch_create_elements`** with precise coordinates, explicit sizing, and color coding. The extra planning time pays for itself in fewer fix iterations.

### 3. Shapes First, Arrows Second — Two Separate Batches

Create shapes in one batch, then arrows in a separate batch. Arrow binding (`startElementId`/`endElementId`) requires shapes to already exist in the scene. Mixing both in one call can work but often produces binding errors.

### 4. Multiple Diagrams on One Canvas

**Never clear the canvas** between diagrams. Place them side-by-side or in a grid:

```
Diagram 1: x=0 to ~1100
Diagram 2: x=1400 onward  (300px gap)
— or —
Row 1: y=0 to ~800
Row 2: y=1100 onward  (300px gap)
```

Use a title text element above each diagram to label it.

### 5. Set roughness: 0 for Clean Diagrams

Excalidraw defaults to hand-drawn style (roughness > 0). For professional, readable diagrams, always set `"roughness": 0` on every element. Also use `"strokeWidth": 2` for arrows to ensure visibility.

## Sizing Rules (Critical — Prevents Truncation)

Excalidraw's Virgil font is ~30% wider than standard fonts. These rules account for that.

### Rectangles

```
width:  max(200, characterCount * 11)
height: 70 (1 line), 80 (2 lines), 100 (3 lines)
fontSize: 16-20
```

### Diamonds (Decision Nodes)

Diamond usable text area is ~50% of the bounding box. **Double your width estimate.**

```
width:  max(400, longestLineChars * 18)
height: max(160, lineCount * 50)
fontSize: 16
```

A diamond with text "Behavioral guideline\nor project standard?" (20 chars) needs at least 400x160.

### Ellipses

Ellipse text area is ~60% of bounding box. Size generously.

```
width:  max(280, characterCount * 14)
height: max(65, lineCount * 35)
fontSize: 16-18
```

### Text Elements (Standalone Titles)

```
fontSize: 24-28 for diagram titles
fontSize: 16-20 for annotations
```

## Arrow Visibility Rules (Critical — Prevents Invisible Arrows)

When arrows are bound to shapes via `startElementId`/`endElementId`, the actual rendered arrow length equals the **gap between shape edges minus binding padding (8px each side)**. If shapes are too close, arrows shrink to 0px and become invisible.

### Minimum Gap Between Connected Shapes

| Connection Direction | Minimum Gap | Recommended Gap |
|---------------------|-------------|-----------------|
| Vertical (top-down flow) | 80px | 120px |
| Horizontal (left-right) | 100px | 140px |

### Calculating Vertical Gap for Flowcharts

```
gap = nextShapeY - (currentShapeY + currentShapeHeight)

Example (diamonds h=160, gap needed ≥ 120):
  Q1: y=260, h=160 → bottom edge = 420
  Q2: y=540         → gap = 540 - 420 = 120px ✓
```

If the gap is < 80px, arrows will be too short to see — especially with labels like "YES"/"NO".

## Workflow: Multi-Diagram Canvas (Spatial Organization)

Excalidraw's infinite canvas supports multiple diagrams coexisting side by side. **Never clear the canvas** to make room — place new diagrams spatially offset from existing ones.

### Before Drawing Anything

Always call `describe_scene` first. It reports:

- **Diagram Zones**: grouped elements with bounding boxes, labels, and element counts
- **Canvas bounding box**: the overall occupied area
- **Suggested placement**: a recommended `(x, y)` for the next diagram (300px right of existing content)

### Creating a New Diagram Alongside Existing Ones

1. **`describe_scene`** — read the suggested placement coordinates
2. **Offset your new diagram** to the suggested area (or 300px+ from the rightmost edge)
3. **Add a title text element** above your diagram (fontSize 24-28) as an identifier
4. **Create shapes** (Batch 1) with coordinates offset to the new area
5. **Create arrows** (Batch 2)
6. **`group_elements`** — group ALL elements of your new diagram together
7. **`set_viewport`** with `scrollToContent: true` to see everything
8. **Screenshot** to verify

### Example Layout

```
  "Architecture" (group A)          "User Flow" (group B)
  x=0 to x=1100                     x=1400 to x=2500
  ┌─────────────────────┐           ┌─────────────────────┐
  │                     │   300px   │                     │
  │   Diagram A         │   gap    │   Diagram B         │
  │                     │           │                     │
  └─────────────────────┘           └─────────────────────┘
```

### Rules

- **Never call `clear_canvas`** unless the user explicitly asks to wipe everything
- **Always `describe_scene` before drawing** to see existing content
- **Group every diagram** so `describe_scene` reports it as a named zone
- **Add a title text element** as the first element of each diagram — this becomes the zone label
- **Use `search_elements`** to find specific diagrams by their title text
- **Use `set_viewport` with `scrollToElementId`** to navigate to a specific diagram

## Workflow: Draw A Diagram

### Phase 1: Plan

Before writing any JSON, plan on paper:

1. **List all elements**: shapes, labels, connections
2. **Choose layout direction**: top-down (flowcharts), left-right (timelines), grid (architecture)
3. **Assign coordinates**: use the sizing rules above to compute widths/heights, then lay out with proper gaps
4. **Assign IDs**: every shape needs a custom `id` so arrows can reference it

### Phase 2: Create Shapes (Batch 1)

```json
{"elements": [
  {"id": "title", "type": "text", "x": 100, "y": 0,
   "text": "MY DIAGRAM", "fontSize": 28, "strokeColor": "#1e1e1e"},
  {"id": "box-a", "type": "rectangle", "x": 0, "y": 80,
   "width": 200, "height": 70, "text": "Service A",
   "backgroundColor": "#a5d8ff", "strokeColor": "#1971c2",
   "roughness": 0, "fontSize": 18},
  {"id": "box-b", "type": "rectangle", "x": 0, "y": 280,
   "width": 200, "height": 70, "text": "Service B",
   "backgroundColor": "#b2f2bb", "strokeColor": "#2f9e44",
   "roughness": 0, "fontSize": 18}
]}
```

### Phase 3: Create Arrows (Batch 2)

```json
{"elements": [
  {"type": "arrow", "x": 100, "y": 150,
   "startElementId": "box-a", "endElementId": "box-b",
   "width": 0, "height": 130, "text": "calls",
   "strokeColor": "#1e1e1e", "roughness": 0, "strokeWidth": 2,
   "endArrowhead": "arrow"}
]}
```

### Phase 4: Check (MANDATORY)

1. `set_viewport` with `scrollToContent: true`
2. Wait 1-2 seconds for render
3. Take screenshot (MCP `get_canvas_screenshot` or Chrome DevTools `take_screenshot`)
4. **Critically evaluate** against the Quality Checklist below
5. Fix any issues, re-screenshot, repeat until clean

## Quality Checklist

After EVERY batch of elements, verify ALL of these:

| Check | What to Look For | Fix |
|-------|-----------------|-----|
| **Text truncation** | Any label cut off or hidden? | Increase shape width/height |
| **Invisible arrows** | Can you see arrows between all connected shapes? | Increase gap between shapes to ≥ 120px |
| **Arrow labels** | Do YES/NO/labels overlap with shapes? | Shorten labels or increase gap |
| **Overlap** | Do any elements share space? | Reposition with more spacing |
| **Readability** | Can all text be read at 50-70% zoom? | Increase fontSize to ≥ 16 |
| **Spacing** | At least 40px gap between unconnected elements? | Spread elements apart |

### If ANY Check Fails

**STOP.** Do not add more elements. Fix the issue first:

1. Use `update_element` to resize/reposition
2. Or `delete_element` + recreate with better coordinates
3. Re-screenshot to verify the fix
4. Only proceed when ALL checks pass

### How to Honestly Evaluate a Screenshot

- Zoom into different regions — don't just glance at the overview
- Check every label individually for truncation
- Trace every arrow path for visibility
- **If you see ANY issue, say "I see [issue], fixing it"** — never say "looks great" unless it truly is

## Color Palette

Use consistent colors from this palette:

| Role | Fill | Stroke | Use For |
|------|------|--------|---------|
| Primary | #a5d8ff | #1971c2 | Main flow, services |
| Success | #b2f2bb | #2f9e44 | Approved, healthy, YES paths |
| Warning | #ffd8a8 | #e8590c | Attention, agents |
| Error | #ffc9c9 | #e03131 | Critical, NO paths, failures |
| Purple | #eebefa | #9c36b5 | Rules, governance |
| Cyan | #99e9f2 | #0c8599 | Data stores, MCP |
| Neutral | #e9ecef | #868e96 | Secondary, annotations |
| Default | #ffffff | #1e1e1e | Decisions, generic |

## Flowchart Template (Tested & Verified)

This template produces clean, readable decision flowcharts:

```
Layout:
  Diamonds: w=400, h=160, fontSize=16, gap=120px vertical
  Answer boxes: w=300, h=80, fontSize=20, offset 130px right of diamonds
  Start ellipse: w=340, h=70, fontSize=18
  Title: fontSize=28
  Arrows: strokeWidth=2, roughness=0
  YES arrows: strokeColor=#2f9e44 (green), horizontal right
  NO arrows: strokeColor=#e03131 (red), vertical down
  All elements: roughness=0
```

## Architecture Diagram Template

```
Layout:
  Zones: large rectangles, backgroundColor=#e9ecef, opacity=30
  Services: w=200, h=70, fontSize=18, spaced 60px apart
  Data stores: w=180, h=60, fontSize=16, strokeColor=#0c8599
  Arrows: solid for sync, dashed (strokeStyle="dashed") for async
  Title: fontSize=24 above each zone
```

## Geometric Thinking (Critical — For All Diagram Types)

Excalidraw only offers basic primitives: rectangles, diamonds, ellipses, lines, arrows, text. Building anything beyond simple box-and-arrow diagrams requires **geometric composition** — combining many small primitives using coordinate math to form complex shapes, textures, and layouts.

### Principle 1: Compose Complex Shapes from Many Small Primitives

**Never use one large primitive where many small ones create a better result.**

A single large diamond looks like a flat rhombus. But 45 small diamonds arranged in a triangular grid with tessellating offset rows looks like a tiled roof. The technique:

1. **Identify the target shape** (triangle, circle, arc, wave, etc.)
2. **Choose a small primitive** that can tile/fill that shape (diamond for tiles, rectangle for bricks, ellipse for clouds)
3. **Compute a grid of positions** that fills the target shape's boundary
4. **Apply row-by-row reduction** for tapered shapes (triangles, cones)
5. **Add interleaving offset rows** to eliminate gaps (tessellation)

```
Example — Triangular tiled roof (building width=380, center_x=1090):

Tile size: 52w × 36h
Row spacing: 28px vertical (= tile height)
Interleave offset: 26px horizontal (= tile width / 2)
Interleave rows at: midpoint y between main rows

Main rows (reduce by 2 tiles per row):
  Row 1: 9 tiles at y=130  |  ◇◇◇◇◇◇◇◇◇
  Row 2: 7 tiles at y=102  |   ◇◇◇◇◇◇◇
  Row 3: 5 tiles at y=74   |    ◇◇◇◇◇
  Row 4: 3 tiles at y=46   |     ◇◇◇
  Row 5: 1 tile  at y=18   |      ◇

Interleaving rows (offset by half tile width, fill gaps):
  Inter 1: 8 tiles at y=116 |  ◇◇◇◇◇◇◇◇
  Inter 2: 6 tiles at y=88  |   ◇◇◇◇◇◇
  Inter 3: 4 tiles at y=60  |    ◇◇◇◇
  Inter 4: 2 tiles at y=32  |     ◇◇

Total: 45 tiles → seamless triangular roof
```

### Principle 2: Tessellation — Eliminate Gaps with Offset Rows

When same-row primitives leave triangular/pointed gaps, add **interleaving rows** offset by half the primitive width:

```
Gap pattern (diamonds side-by-side):     Filled with interleaving row:
  /\  /\  /\  /\                           /\  /\  /\  /\
 /  \/  \/  \/  \                         /  \/  \/  \/  \
 \  /\  /\  /\  /                         \ /\/\/\/\/\/\ /
  \/  \/  \/  \/                           ◇◇◇◇◇◇◇◇◇  ← offset row
                                           /\  /\  /\  /\
```

**Formula for interleaving:**
```
main_row_y[n] = base_y - n * row_spacing
inter_row_y[n] = (main_row_y[n] + main_row_y[n+1]) / 2
inter_row_x_offset = tile_width / 2
inter_row_count = main_row_count[n] - 1
```

### Principle 3: Parametric Positioning — Use Formulas, Not Guessing

Compute element positions mathematically. Common formulas:

**Centering N items in a container:**
```
item_x[i] = container_x + (container_width - N * item_width) / (N + 1) * (i + 1) + i * item_width
```

**Circular arrangement (N items around center):**
```
angle[i] = (2π / N) * i + rotation_offset
x[i] = center_x + radius * cos(angle[i]) - item_width / 2
y[i] = center_y + radius * sin(angle[i]) - item_height / 2
```

**Triangular reduction (pyramid/roof):**
```
count[row] = base_count - 2 * row
x_start[row] = center_x - (count[row] * tile_width) / 2
y[row] = base_y - row * row_spacing
```

**Isometric projection (2.5D diagrams):**
```
screen_x = (grid_x - grid_y) * tile_width / 2
screen_y = (grid_x + grid_y) * tile_height / 2
```

### Principle 4: Scale Primitives to Context

When applying a technique to different-sized containers, **scale the primitive size proportionally**:

```
Hut (body width 290px)  → tiles 40w × 28h, 9 per base row
Building (body width 380px) → tiles 52w × 36h, 9 per base row
```

Maintain the same count-per-row for visual consistency; adjust individual tile dimensions.

### Technique Catalogs

For detailed recipes and formulas for specific diagram types, see [geometric-thinking.md](references/geometric-thinking.md):

- **Illustrative diagrams**: 11 visual element recipes (roofs, walls, clouds, trees, fences, water, smoke, windows, stairs)
- **Flow diagrams**: Sugiyama-inspired 4-step hierarchical layout (layer assignment → ordering → coordinates → edge routing)
- **Architecture diagrams**: Zone-grid layout with service grid-packing and dependency layering
- **Isometric/2.5D diagrams**: Screen projection formulas for depth illusion
- **Repeating patterns**: Generic repeat and brick-pattern offset formulas
- **Anti-patterns**: 6 common geometric composition mistakes and fixes

## Workflow: Iterative Refinement

```
create shapes (batch 1)
  → create arrows (batch 2)
    → set_viewport(scrollToContent: true)
      → wait 1-2s
        → screenshot
          → evaluate quality checklist
            → issues? fix → re-screenshot → re-evaluate
              → clean? proceed to next diagram section
```

For multi-diagram canvases, offset each new diagram by 300px+ from the previous one's bounding box.

## Workflow: Tenants, Projects & Search

Multi-tenant: each Cursor workspace auto-gets its own tenant (SHA-256 hash of workspace path). Globally-configured MCPs detect per-window workspace automatically.

| Task | Tool | Notes |
|------|------|-------|
| List workspaces | `list_tenants` | Returns id, name, workspace_path |
| Switch workspace | `switch_tenant` with `tenantId` | Canvas reloads tenant's elements |
| List projects | `list_projects` | Projects group diagrams within a tenant |
| Switch/create project | `switch_project` | Pass `projectId` or `createName` |
| Full-text search | `search_elements` with `query` | Searches labels and text content |
| Version history | `element_history` | Pass `elementId` or omit for project-wide |

## Workflow: Refine An Existing Diagram

1. `describe_scene` to understand current state
2. Identify targets by `id` or label text (or use `search_elements` for text search)
3. `update_element` to move/resize/recolor
4. Screenshot to verify
5. If updates fail: check element id exists (`get_element`), element isn't locked
6. Use `element_history` to see what changed if something looks wrong

## Workflow: File I/O

- Export: `export_scene` (optional `filePath`)
- Import: `import_scene` with `mode: "replace"` or `"merge"`
- Image export: `export_to_image` with `format: "png"` or `"svg"` (requires browser)

## Workflow: Snapshots

1. `snapshot_scene` with a name before risky changes
2. Make changes, screenshot to evaluate
3. `restore_snapshot` to rollback if needed

**Note**: Snapshot restore may not always reload elements into the active view. If the canvas appears empty after restore, re-fetch elements or recreate.

## Workflow: Viewport Control

- `scrollToContent: true` — auto-fit all elements
- `scrollToElementId: "my-element"` — center on specific element
- `zoom: 0.7, offsetX: 100, offsetY: 50` — manual camera for close-up review

## Anti-Patterns (Common Mistakes)

| Mistake | Why It Fails | Do This Instead |
|---------|-------------|-----------------|
| Using `create_from_mermaid` for final diagrams | Overlapping text, poor layout | Use `batch_create_elements` with coordinates |
| Shapes too small for text | Truncation, especially in diamonds | Use sizing formulas above |
| No gap between connected shapes | Arrows become invisible (0px length) | Maintain 120px+ vertical gap |
| Clearing canvas between diagrams | Loses previous work, requires `confirm: true` | Place diagrams side-by-side using spatial offset; call `describe_scene` first |
| Skipping screenshot verification | Invisible defects compound | Screenshot after EVERY batch |
| Shapes + arrows in one batch | Binding errors | Shapes first, arrows second |
| Default roughness (hand-drawn look) | Unprofessional for technical diagrams | Set `roughness: 0` on all elements |
| Trusting MCP screenshot alone | May return empty image | Use Chrome DevTools as fallback |

## MCP Tool Quick Reference (32 Tools)

| Category | Tools |
|----------|-------|
| Element CRUD (9) | `create_element`, `get_element`, `update_element`, `delete_element`, `query_elements`, `batch_create_elements`, `duplicate_elements`, `search_elements`, `element_history` |
| Layout (6) | `align_elements`, `distribute_elements`, `group_elements`, `ungroup_elements`, `lock_elements`, `unlock_elements` |
| Scene (4) | `describe_scene`, `get_canvas_screenshot`, `get_resource`, `read_diagram_guide` |
| File I/O (4) | `export_scene`, `import_scene`, `export_to_image`, `export_to_excalidraw_url` |
| State (3) | `clear_canvas`, `snapshot_scene`, `restore_snapshot` |
| Viewport (1) | `set_viewport` |
| Tenants (2) | `list_tenants`, `switch_tenant` |
| Projects (2) | `list_projects`, `switch_project` |
| Conversion (1) | `create_from_mermaid` (⚠ low quality — use `batch_create_elements` instead) |

## References

- `references/cheatsheet.md`: Complete MCP tool list (32 tools) + REST API endpoints + payload shapes + env vars
