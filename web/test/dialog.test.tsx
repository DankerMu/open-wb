import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { trapDialogFocus } from "../src/lib/dialog.js";

afterEach(cleanup);

it("cycles keyboard focus inside a dialog without entering disabled controls", () => {
  render(
    <div>
      <button type="button">Outside</button>
      <dialog onKeyDown={trapDialogFocus} open>
        <input aria-label="Name" />
        <button disabled type="button">
          Pending
        </button>
        <button type="button">Cancel</button>
      </dialog>
    </div>,
  );
  const first = screen.getByLabelText("Name");
  const last = screen.getByRole("button", { name: "Cancel" });
  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(last);
});
