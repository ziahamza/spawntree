import { RouterProvider } from "@tanstack/react-router";
import { hydrateRoot } from "react-dom/client";
import { router } from "./router";

hydrateRoot(document, <RouterProvider router={router} />);
