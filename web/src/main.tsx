import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { createAppRouter } from "./routes/index.js";
import { ToastProvider } from "./ui/index.js";

const router = createAppRouter();
const root = createRoot(document.getElementById("root") as HTMLElement);

root.render(
  <ToastProvider>
    <RouterProvider router={router} />
  </ToastProvider>,
);

let disposed = false;

export function disposeApp() {
  if (disposed) {
    return;
  }

  disposed = true;
  root.unmount();
  router.dispose();
}
