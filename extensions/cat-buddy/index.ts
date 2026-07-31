import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  type EditorComponent,
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

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

class CatSprite {
  private frameIndex = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private eligible = false;

  constructor(
    private readonly tui: TUI,
    private mode: AnimationMode,
    private working: boolean,
    private visible: boolean,
  ) {}

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) this.schedulePolicy();
    else this.cancelTimer();
    this.tui.requestRender();
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

  renderEditor(editor: EditorComponent, render: (width: number) => string[], width: number): string[] {
    const base = render(width);
    const rows = (this.tui as TUI & { terminal?: { rows?: number } }).terminal?.rows ?? 24;
    this.setEligible(width >= 34 && rows >= 10 && base.length > 0);
    if (!this.visible || !this.eligible) return base;

    const color = editor.borderColor ?? ((value: string) => value);
    const padding = " ".repeat(Math.max(0, width - CAT_WIDTH - 2));
    const pose = getCatPose(this.frameIndex);
    const topRows = pose.slice(0, -1).map((line) =>
      padding + truncateToWidth(color(line), CAT_WIDTH, "")
    );

    const border = base[0]!;
    const borderSegment = sliceByColumn(border, width - CAT_WIDTH - 2, CAT_WIDTH, true);
    const bottom = pose.at(-1)!;
    const leadingWidth = bottom.length - bottom.trimStart().length;
    const trailingWidth = Math.max(0, CAT_WIDTH - bottom.length);
    const leadingBorder = sliceByColumn(borderSegment, 0, leadingWidth, true);
    const trailingBorder = sliceByColumn(borderSegment, CAT_WIDTH - trailingWidth, trailingWidth, true);
    const spriteBorder = leadingBorder + color(bottom.slice(leadingWidth)) + trailingBorder;
    const left = sliceByColumn(border, 0, width - CAT_WIDTH - 2, true);
    const right = sliceByColumn(border, width - 2, 2, true);
    const mergedBorder = left + spriteBorder + right;

    // The editor remains the focused component. Two companion rows are added,
    // while its feet replace a segment of the existing top border.
    return [...topRows, visibleWidth(mergedBorder) <= width
      ? mergedBorder
      : truncateToWidth(mergedBorder, width, ""), ...base.slice(1)];
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  private schedulePolicy(startSmartImmediately = false): void {
    if (this.disposed || !this.visible || !this.eligible) return;

    if (this.mode === "always" || (this.mode === "working" && this.working)) {
      this.scheduleContinuousFrame();
    } else if (this.mode === "smart") {
      if (startSmartImmediately || this.frameIndex > 0) this.scheduleSmartFrame();
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

  private setEligible(eligible: boolean): void {
    if (this.eligible === eligible) return;
    this.eligible = eligible;
    if (eligible) this.schedulePolicy();
    else this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export default function (pi: ExtensionAPI) {
  let host: CatSprite | undefined;
  let previousFactory: EditorFactory | undefined;
  let installedFactory: EditorFactory | undefined;
  let mode: AnimationMode = "smart";
  let visible = true;
  let working = false;

  const syncAnimation = () => host?.setBehavior(mode, working);

  const mount = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    previousFactory = ctx.ui.getEditorComponent();
    installedFactory = (tui, theme, keybindings) => {
      host?.dispose();
      const editor = previousFactory?.(tui, theme, keybindings)
        ?? new CustomEditor(tui, theme, keybindings);
      const render = editor.render.bind(editor);
      host = new CatSprite(tui, mode, working, visible);
      editor.render = (width: number) => host?.renderEditor(editor, render, width) ?? render(width);
      return editor;
    };
    ctx.ui.setEditorComponent(installedFactory);
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
      host?.setVisible(visible);
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
    host?.dispose();
    host = undefined;
    if (ctx.mode === "tui" && ctx.ui.getEditorComponent() === installedFactory) {
      ctx.ui.setEditorComponent(previousFactory);
    }
    previousFactory = undefined;
    installedFactory = undefined;
  });
}
