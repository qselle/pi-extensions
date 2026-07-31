import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  sliceByColumn,
  truncateToWidth,
  type Component,
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
  CAT_WIDTH,
  getCatPose,
} from "./frames.js";
import {
  CatPanel,
  parseCatCommand,
  type AnimationMode,
  type CatAction,
} from "./panel.js";

const WIDGET_KEY = "cat-buddy";

class CatSprite implements Component {
  private frameIndex = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private mode: AnimationMode,
    private working: boolean,
  ) {
    this.schedulePolicy(mode === "smart" && working);
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
    if (width < CAT_WIDTH) return [];
    const padding = " ".repeat(Math.max(0, width - CAT_WIDTH - 2));
    const borderLine = this.theme.fg("borderMuted", "─".repeat(CAT_WIDTH));
    const pose = getCatPose(this.frameIndex);
    return pose.map((line, index) => {
      let rendered: string;
      if (index !== pose.length - 1) {
        rendered = this.theme.fg("text", line);
      } else {
        const leadingWidth = line.length - line.trimStart().length;
        const trailingWidth = Math.max(0, CAT_WIDTH - line.length);
        const leadingBorder = sliceByColumn(borderLine, 0, leadingWidth, true);
        const trailingBorder = sliceByColumn(borderLine, 0, trailingWidth, true);
        rendered = leadingBorder + this.theme.fg("text", line.slice(leadingWidth)) + trailingBorder;
      }
      return padding + truncateToWidth(rendered, CAT_WIDTH, "");
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

export default function (pi: ExtensionAPI) {
  let host: CatSprite | undefined;
  let mode: AnimationMode = "smart";
  let visible = true;
  let working = false;

  const syncAnimation = () => host?.setBehavior(mode, working);

  const mount = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || !visible) return;
    ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      host = new CatSprite(tui, theme, mode, working);
      return host;
    }, { placement: "aboveEditor" });
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

  pi.registerShortcut("ctrl+shift+c", {
    description: "Show or hide the input-bar cat",
    handler: (ctx) => applyAction({ type: "visibility", visible: !visible }, ctx),
  });

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
