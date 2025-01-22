#!/bin/bash

# Load environment variables from .env file
set -a
source .env
set +a

# Debug: Print the values of the environment variables
echo "PROJECT_ID: $PROJECT_ID"
echo "LOCATION: $LOCATION"
echo "PROCESSOR_ID: $PROCESSOR_ID"
echo "BUCKET_NAME: $BUCKET_NAME"
echo "REGION: $REGION"
echo "AIRTABLE_API_KEY: $AIRTABLE_API_KEY"
echo "AIRTABLE_BASE_ID: $AIRTABLE_BASE_ID"
echo "AIRTABLE_TABLE_NAME: $AIRTABLE_TABLE_NAME"

# Create a temporary file for environment variables in proper YAML format
cat > env.yaml << EOL
PROJECT_ID: ${PROJECT_ID}
LOCATION: ${LOCATION}
PROCESSOR_ID: ${PROCESSOR_ID}
BUCKET_NAME: ${BUCKET_NAME}
REGION: ${REGION}
AIRTABLE_API_KEY: ${AIRTABLE_API_KEY}
AIRTABLE_BASE_ID: ${AIRTABLE_BASE_ID}
AIRTABLE_TABLE_NAME: ${AIRTABLE_TABLE_NAME}
EOL

# Deploy the Cloud Function
gcloud functions deploy process_document \
    --runtime python311 \
    --trigger-http \
    --allow-unauthenticated \
    --env-vars-file env.yaml \
    --region $REGION \
    --project $PROJECT_ID
    --memory 512MB

# Get the Cloud Function URL after deployment
CLOUD_FUNCTION_URL="https://${REGION}-${PROJECT_ID}.cloudfunctions.net/process_document"

# Clean up temporary env file
rm env.yaml

# Update the airtable-automation.js with the actual Cloud Function URL
if [ -n "$CLOUD_FUNCTION_URL" ]; then
    echo "Cloud Function URL: $CLOUD_FUNCTION_URL"
    sed -i.bak "s|YOUR_CLOUD_FUNCTION_URL|$CLOUD_FUNCTION_URL|g" airtable-automation.js
    rm airtable-automation.js.bak
    echo "Updated airtable-automation.js with the Cloud Function URL"
else
    echo "Error: Could not get Cloud Function URL"
    exit 1
fi