#!/bin/sh
echo "Running tests..."
GCLOUD_PROJECT=activitypub-firebase-dev node --experimental-vm-modules node_modules/.bin/jest --runInBand --watchAll