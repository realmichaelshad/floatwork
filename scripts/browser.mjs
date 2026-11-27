// Launches headless Chromium for the perf run, with the same GPU flags as the end-to-end tests.
import { chromium } from '@playwright/test';

export async function launch() {
  return chromium.launch({
    headless: true,
    args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  });
}

export const BASE = 'http://127.0.0.1:5311/dist/';
