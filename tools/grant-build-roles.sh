#!/usr/bin/env bash
# New Google Cloud projects build Cloud Functions with the default compute account,
# which needs these roles to build and store the function code.
P=gingersues-schedule-9554a
N=$(gcloud projects describe $P --format='value(projectNumber)')
add() { gcloud projects add-iam-policy-binding $P --member="$1" --role="$2" --condition=None -q >/dev/null && echo "ok  $2" || echo "FAILED  $2"; }
for r in roles/cloudbuild.builds.builder roles/logging.logWriter roles/artifactregistry.writer roles/storage.objectViewer; do
  add serviceAccount:$N-compute@developer.gserviceaccount.com $r
done
echo "Done."
