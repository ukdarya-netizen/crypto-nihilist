#!/bin/bash
set -e
pnpm install
pnpm --filter db push
