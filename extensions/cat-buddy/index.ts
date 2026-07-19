import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  sliceByColumn,
  truncateToWidth,
  type Component,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  pickRandomDelay,
  SMART_IDLE_DELAY_MS,
  SMART_WORKING_DELAY_MS,
} from "./animation.js";
import {
  CAT_FRAME_DURATION_MS,
  CAT_FRAME_SEQUENCE,
  CAT_HEIGHT,
  CAT_WIDTH,
  getCatPose,
} from "./frames.js";
import { observeRenderedFrames } from "./frame-observer.js";
import {
  containsTerminalText,
  findEditorTopBorder,
  rightEdgeRange,
} from "./layout.js";
import {
  CatPanel,
  parseCatCommand,
  type AnimationMode,
  type CatAction,
} from "./panel.js";

const WIDGET_KEY = "cat-buddy-overlay-host";

class CatSprite implements Component {
  private borderLine: string;
  private frameIndex = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private mode: AnimationMode,
    private working: boolean,
  ) {
    this.borderLine = theme.fg("borderMuted", "─".repeat(CAT_WIDTH));
    this.schedulePolicy(mode === "smart" && working);
  }

  setBorderLine(line: string): void {
    this.borderLine = line;
  }

  setBehavior(mode: AnimationMode, working: boolean): void {
    if (this.mode === mode && this.working === working) return;

    const becameWorking = !this.working && working;
    this.mode = mode;
    this.working = working;
    this.cancelTimer();
    this.resetFrame();
    this.schedulePolicy(mode === "smart" && (becameWorking || working));
  }

  render(width: number): string[] {
    const pose = getCatPose(this.frameIndex);
    return pose.map((line, index) => {
      if (index !== pose.length - 1) {
        return truncateToWidth(this.theme.fg("text", line), width, "");
      }

      const leadingWidth = line.length - line.trimStart().length;
      const trailingWidth = Math.max(0, CAT_WIDTH - line.length);
      const leadingBorder = sliceByColumn(this.borderLine, 0, leadingWidth, true);
      const trailingBorder = sliceByColumn(this.borderLine, 0, trailingWidth, true);
      const merged = leadingBorder + this.theme.fg("text", line.slice(leadingWidth)) + trailingBorder;
      return truncateToWidth(merged, width, "");
    });
  }

  invalidate(): void {
    // Theme methods are applied during render, so there is no themed cache.
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  private schedulePolicy(startSmartImmediately = false): void {
    if (this.disposed) return;

    if (this.mode === "always" || (this.mode === "working" && this.working)) {
      this.scheduleContinuousFrame();
    } else if (this.mode === "smart") {
      if (startSmartImmediately) this.scheduleSmartFrame();
      else this.scheduleSmartCycle();
    }
  }

  private scheduleContinuousFrame(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.frameIndex = (this.frameIndex + 1) % CAT_FRAME_SEQUENCE.length;
      this.tui.requestRender();
      this.schedulePolicy();
    }, CAT_FRAME_DURATION_MS);
  }

  private scheduleSmartFrame(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.frameIndex += 1;

      if (this.frameIndex >= CAT_FRAME_SEQUENCE.length - 1) {
        // The final source frame is the neutral pose, so resetting the index is
        // visually seamless while the cat waits before its next movement.
        this.frameIndex = 0;
        this.tui.requestRender();
        this.scheduleSmartCycle();
        return;
      }

      this.tui.requestRender();
      this.scheduleSmartFrame();
    }, CAT_FRAME_DURATION_MS);
  }

  private scheduleSmartCycle(): void {
    const range = this.working ? SMART_WORKING_DELAY_MS : SMART_IDLE_DELAY_MS;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.scheduleSmartFrame();
    }, pickRandomDelay(range));
  }

  private resetFrame(): void {
    if (this.frameIndex === 0) return;
    this.frameIndex = 0;
    this.tui.requestRender();
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

class EditorDockedCat implements Component {
  private readonly sprite: CatSprite;
  private readonly handle: OverlayHandle;
  private readonly stopObservingFrames: () => void;
  private readonly placement: OverlayOptions = {
    nonCapturing: true,
    anchor: "bottom-right",
    width: CAT_WIDTH,
    maxHeight: CAT_HEIGHT,
    margin: { right: 2 },
    visible: (columns, rows) => this.canObserveFrames && columns >= 34 && rows >= 10,
  };
  private disposed = false;
  private canObserveFrames = false;
  private hidden = false;

  constructor(
    private readonly tui: TUI,
    theme: Theme,
    mode: AnimationMode,
    working: boolean,
  ) {
    this.sprite = new CatSprite(tui, theme, mode, working);
    const unsubscribe = observeRenderedFrames(tui, (frame, columns, rows) => {
      this.placeBesideEditor(frame, columns, rows);
    });
    this.canObserveFrames = unsubscribe !== undefined;
    this.stopObservingFrames = unsubscribe ?? (() => {});
    this.handle = tui.showOverlay(this.sprite, this.placement);
  }

  setBehavior(mode: AnimationMode, working: boolean): void {
    this.sprite.setBehavior(mode, working);
  }

  render(): string[] {
    // The host owns only the overlay lifecycle and consumes no layout rows.
    // Collision detection below hides the sprite if the shared row is occupied.
    return [];
  }

  invalidate(): void {
    this.sprite.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sprite.dispose();
    this.handle.hide();
    this.stopObservingFrames();
  }

  private placeBesideEditor(frame: string[], columns: number, rows: number): void {
    const visibleFrom = Math.max(0, frame.length - rows);
    const editorTop = findEditorTopBorder(frame, visibleFrom, columns, rows);
    const catTop = editorTop === undefined ? -1 : editorTop - (CAT_HEIGHT - 1);
    const { left, right } = rightEdgeRange(columns, CAT_WIDTH, 2);

    if (
      editorTop === undefined
      || catTop < visibleFrom
      || areaContainsText(frame, catTop, editorTop, left, right)
    ) {
      this.setHidden(true);
      return;
    }

    this.sprite.setBorderLine(sliceByColumn(frame[editorTop]!, 0, CAT_WIDTH, true));
    this.placement.row = catTop - visibleFrom;
    this.placement.col = left;
    this.setHidden(false);
  }

  private setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    this.handle.setHidden(hidden);
  }
}

function areaContainsText(
  frame: string[],
  startRow: number,
  endRowExclusive: number,
  left: number,
  right: number,
): boolean {
  for (let row = startRow; row < endRowExclusive; row++) {
    const cells = sliceByColumn(frame[row] ?? "", left, right, true);
    if (containsTerminalText(cells)) return true;
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  let host: EditorDockedCat | undefined;
  let mode: AnimationMode = "smart";
  let visible = true;
  let working = false;

  const syncAnimation = () => host?.setBehavior(mode, working);

  const mount = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || !visible) return;
    ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      host = new EditorDockedCat(tui, theme, mode, working);
      return host;
    });
  };

  pi.on("session_start", (_event, ctx) => {
    working = false;
    mount(ctx);
  });

  pi.on("agent_start", () => {
    working = true;
    syncAnimation();
  });

  pi.on("agent_settled", () => {
    working = false;
    syncAnimation();
  });

  const statusText = () => `Cat: ${visible ? "visible" : "hidden"}; animation: ${mode}`;

  const applyAction = (action: CatAction, ctx: ExtensionContext) => {
    if (action.type === "visibility") {
      visible = action.visible;
      if (visible) {
        mount(ctx);
      } else {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        host = undefined;
      }
    } else {
      mode = action.mode;
      syncAnimation();
    }
    ctx.ui.notify(statusText(), "info");
  };

  pi.registerCommand("cat", {
    description: "Open cat controls or set show, hide, smart, always, working, or static",
    getArgumentCompletions: (prefix) => {
      const commands = ["status", "show", "hide", "smart", "always", "working", "static"];
      const items = commands
        .filter((command) => command.startsWith(prefix.toLowerCase()))
        .map((command) => ({ value: command, label: command }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const command = parseCatCommand(args);
      if (command.type === "invalid") {
        ctx.ui.notify("Usage: /cat [status|show|hide|smart|always|working|static]", "error");
        return;
      }
      if (command.type === "status" || (command.type === "panel" && ctx.mode !== "tui")) {
        ctx.ui.notify(statusText(), "info");
        return;
      }
      if (command.type === "panel") {
        await ctx.ui.custom<void>(
          (_tui, theme, _keybindings, done) => new CatPanel(
            visible,
            mode,
            theme,
            () => done(undefined),
            (action) => applyAction(action, ctx),
          ),
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              width: "60%",
              minWidth: 40,
              maxHeight: "80%",
            },
          },
        );
        return;
      }
      applyAction(command, ctx);
    },
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    host = undefined;
  });
}
