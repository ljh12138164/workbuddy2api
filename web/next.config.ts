import type { NextConfig } from 'next';

const config: NextConfig = { output: 'export', trailingSlash: true, outputFileTracingRoot: process.cwd() };
export default config;
