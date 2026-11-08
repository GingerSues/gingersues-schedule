#!/usr/bin/env bash
# Run once in Cloud Shell if a deploy stops with "We failed to modify the IAM policy for the project".
set -uo pipefail
P=gingersues-schedule-9554a
N=$(gcloud projects describe $P --format='value(projectNumber)')
gcloud services enable compute.googleapis.com run.googleapis.com eventarc.googleapis.com pubsub.googleapis.com secretmanager.googleapis.com --project $P
gcloud beta services identity create --service=pubsub.googleapis.com --project $P >/dev/null 2>&1
gcloud beta services identity create --service=eventarc.googleapis.com --project $P >/dev/null 2>&1
add() { gcloud projects add-iam-policy-binding $P --member="$1" --role="$2" --condition=None -q >/dev/null && echo "ok  $2" || echo "FAILED  $2  for $1"; }
add serviceAccount:service-$N@gcp-sa-pubsub.iam.gserviceaccount.com roles/iam.serviceAccountTokenCreator
add serviceAccount:$N-compute@developer.gserviceaccount.com roles/run.invoker
add serviceAccount:$N-compute@developer.gserviceaccount.com roles/eventarc.eventReceiver
add serviceAccount:$N-compute@developer.gserviceaccount.com roles/secretmanager.secretAccessor
add serviceAccount:$N-compute@developer.gserviceaccount.com roles/datastore.user
add serviceAccount:service-$N@gcp-sa-eventarc.iam.gserviceaccount.com roles/eventarc.serviceAgent
echo "Done."
