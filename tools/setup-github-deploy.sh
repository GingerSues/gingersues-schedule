#!/usr/bin/env bash
# Run once in Google Cloud Shell. Lets GitHub deploy this project without a key file
# (Workload Identity Federation), limited to the GingerSues/gingersues-schedule repository.
set -euo pipefail
PROJECT="${1:-$(gcloud config get-value project 2>/dev/null)}"
REPO="GingerSues/gingersues-schedule"
[ -n "$PROJECT" ] || { echo "Usage: bash setup.sh YOUR_PROJECT_ID"; exit 1; }
NUM=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
SA="github-deploy@$PROJECT.iam.gserviceaccount.com"
echo "Setting up project $PROJECT ($NUM)…"
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com cloudresourcemanager.googleapis.com --project "$PROJECT"
gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud iam service-accounts create github-deploy --project "$PROJECT" --display-name "GitHub deploy"
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role roles/owner --condition=None -q >/dev/null
gcloud iam workload-identity-pools describe github --project "$PROJECT" --location global >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools create github --project "$PROJECT" --location global --display-name "GitHub"
gcloud iam workload-identity-pools providers describe github --project "$PROJECT" --location global --workload-identity-pool github >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools providers create-oidc github --project "$PROJECT" --location global \
    --workload-identity-pool github --display-name "GitHub" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition "assertion.repository=='$REPO'"
gcloud iam service-accounts add-iam-policy-binding "$SA" --project "$PROJECT" --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$NUM/locations/global/workloadIdentityPools/github/attribute.repository/$REPO" -q >/dev/null
echo
echo "Done. Add these as GitHub repository VARIABLES:"
echo "  FIREBASE_PROJECT_ID = $PROJECT"
echo "  WIF_PROVIDER        = projects/$NUM/locations/global/workloadIdentityPools/github/providers/github"
