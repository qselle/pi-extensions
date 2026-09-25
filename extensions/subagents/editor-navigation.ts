import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
export type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

/** Intercept only an empty main editor; dialogs and other components keep focus. */
export function navigationEditor(previous: EditorFactory | undefined, open: () => boolean,
  decorated = new WeakSet<object>()): EditorFactory {
  return (tui, theme, keys) => {
    const editor = previous?.(tui, theme, keys) ?? new CustomEditor(tui, theme, keys, { embedWorkingStatus: true });
    if (decorated.has(editor)) return editor;
    decorated.add(editor);
    const handle = editor.handleInput.bind(editor);
    editor.handleInput = (data) => {
      if (matchesKey(data, "right")) {
        const text = editor.getExpandedText?.() ?? editor.getText();
        if (text.length === 0 && open()) return;
      }
      handle(data);
    };
    return editor;
  };
}
