# Document AI Integration with Airtable

This project integrates Google Cloud Document AI with Airtable to automatically process uploaded documents and store the extracted text. The system uses Google Cloud Functions to handle the processing pipeline.

## Prerequisites

- Google Cloud Platform (GCP) account
- Airtable account
- Google Cloud SDK installed locally
- Python 3.11 or later
- Document AI processor set up in GCP

## Setup Instructions

### 1. Google Cloud Setup

1. Create a new project in Google Cloud Console or use an existing one
2. Enable the following APIs:
   - Cloud Functions API
   - Document AI API
   - Cloud Build API
   - Cloud Run API

3. Create a Document AI processor:
   - Go to Document AI in GCP Console
   - Create a new processor (e.g., General Document Parser)
   - Note down the processor ID

### 2. Airtable Setup

1. Create a new base in Airtable
2. Create a table with the following fields:
   - Document (Attachment type)
   - Document_AI_Response (Long text type)
3. Generate an API key from your Airtable account
4. Note down:
   - Base ID (found in API documentation)
   - Table ID (found in API documentation)
   - API Key

### 3. Local Environment Setup

1. Clone this repository
2. Create a `.env` file with the following variables:

```bash
PROJECT_ID=your-project-id
LOCATION=your-region
PROCESSOR_ID=your-processor-id
BUCKET_NAME=your-bucket-name
AIRTABLE_API_KEY=your-airtable-api-key
AIRTABLE_BASE_ID=your-airtable-base-id
AIRTABLE_TABLE_NAME=your-airtable-table-name
```

### 4. Deployment

1. Make the deployment script executable:

```bash
chmod +x deploy.sh
```

2. Deploy the Cloud Function:

```bash
./deploy.sh
```

3. The script will output the Cloud Function URL - note this down

### 5. Airtable Automation Setup

1. In your Airtable base, create a new automation
2. Set the trigger to "When record is created" or "When record matches conditions"
3. Add a "Run script" action
4. Copy the contents of `airtable-automation.js` into the script editor
5. Update the script with your Cloud Function URL if not already updated by the deployment script

## File Structure

- `main.py`: Cloud Function code that processes documents using Document AI
- `deploy.sh`: Deployment script for the Cloud Function
- `requirements.txt`: Python dependencies
- `airtable-automation.js`: Airtable automation script
- `.env`: Environment variables configuration

## How It Works

1. When a document is uploaded to Airtable, it triggers the automation
2. The automation script sends the document URL to the Cloud Function
3. The Cloud Function:
   - Downloads the document from Airtable
   - Processes it using Document AI
   - Sends the extracted text back to Airtable
4. The extracted text is stored in the Document_AI_Response field

## Troubleshooting

### Common Issues

1. **Cloud Function Deployment Fails**
   - Ensure all required APIs are enabled
   - Check if you have sufficient permissions
   - Verify your .env file has correct values

2. **Document Processing Fails**
   - Check if the Document AI processor is properly set up
   - Verify the document format is supported
   - Check the Cloud Function logs for specific errors

3. **Airtable Integration Issues**
   - Verify your API key has correct permissions
   - Check if the table and field names match exactly
   - Ensure the automation is properly configured

### Logging

- Cloud Function logs can be viewed in Google Cloud Console
- Each step of the process includes detailed logging
- Check both Cloud Function and Airtable automation logs for troubleshooting

## Security Considerations

- The Cloud Function is deployed with public access (--allow-unauthenticated)
- Consider implementing additional authentication if needed
- Airtable API key should be kept secure and not shared
- Use environment variables for sensitive information

## Limitations

- Document AI processing time may vary based on document size (up to 15 pages)
- Airtable API has rate limits
- Maximum file size limitations apply for both Airtable and Document AI

## Contributing

Feel free to submit issues and enhancement requests!
