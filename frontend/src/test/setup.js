import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// The whole suite runs in parallel on slow machines: wait longer than the 1 s default for async screens.
configure({ asyncUtilTimeout: 4000 });
