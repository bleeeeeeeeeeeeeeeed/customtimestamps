import { findByName, findByProps } from "@vendetta/metro";
import { after, before } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { showInputAlert } from "@vendetta/ui/alerts";
import { findInReactTree } from "@vendetta/utils";

// { [messageId]: epochMillis }
storage.overrides ??= {};

const RowManager = findByName("RowManager");
const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
const { FluxDispatcher } = findByProps("dispatch", "subscribe");

const patches: (() => void)[] = [];

// 1) DISPLAY PATCH — swap the timestamp when a message row is generated
patches.push(
  after("generate", RowManager.prototype, ([data], row) => {
    const id = row?.message?.id;
    if (!id || !storage.overrides[id]) return;

    // CONFIRM AT RUNTIME: log `row.message` once to verify the timestamp field/type.
    const custom = storage.overrides[id];
    const ts = row.message.timestamp;
    if (ts?.clone) {
      const m = ts.clone();   // moment-like object
      m._d = new Date(custom);
      row.message.timestamp = m;
    } else {
      row.message.timestamp = new Date(custom);
    }
  })
);

// 2) EDIT UI — add a "Set custom time" button to the long-press action sheet
patches.push(
  before("openLazy", LazyActionSheet, ([component, key, msg]) => {
    if (key !== "MessageLongPressActionSheet") return;
    const message = msg?.message;
    if (!message) return;

    component.then((instance: any) => {
      const unpatch = after("default", instance, (_, res) => {
        unpatch();
        const buttons = findInReactTree(res, (n) => n?.[0]?.type?.name === "ButtonRow");
        if (!buttons) return;

        buttons.unshift({
          ...buttons[0],
          props: {
            ...buttons[0].props,
            label: "Set custom time",
            onPress: () => {
              LazyActionSheet.hideActionSheet();
              showInputAlert({
                title: "Custom time",
                placeholder: "e.g. 2026-06-22 14:30  or  14:30",
                confirmText: "Save",
                onConfirm: (input: string) => {
                  const parsed = parseTime(input);
                  if (!isNaN(parsed)) {
                    storage.overrides[message.id] = parsed;
                    FluxDispatcher.dispatch({ type: "MESSAGE_UPDATE", message });
                  }
                },
              });
            },
          },
        });
      });
    });
  })
);

function parseTime(input: string): number {
  const hm = input.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date();
    d.setHours(+hm[1], +hm[2], 0, 0);
    return d.getTime();
  }
  return new Date(input).getTime();
}

export const onUnload = () => patches.forEach((u) => u());
