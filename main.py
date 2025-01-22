import os
import functions_framework
from google.cloud import documentai
from google.cloud import storage
import json
from flask import jsonify
import requests

PROJECT_ID = os.getenv('PROJECT_ID')
LOCATION = os.getenv('LOCATION')  # Format is 'us' or 'eu'
PROCESSOR_ID = os.getenv('PROCESSOR_ID')  # Document AI processor ID
BUCKET_NAME = os.getenv('BUCKET_NAME')

# Airtable configuration
AIRTABLE_API_KEY = os.getenv('AIRTABLE_API_KEY')
AIRTABLE_BASE_ID = os.getenv('AIRTABLE_BASE_ID')
AIRTABLE_TABLE_NAME = os.getenv('AIRTABLE_TABLE_NAME')

@functions_framework.http
def process_document(request):
    # Enable CORS
    if request.method == 'OPTIONS':
        headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '3600'
        }
        return ('', 204, headers)

    headers = {'Access-Control-Allow-Origin': '*'}

    try:
        request_json = request.get_json()
        
        if not request_json or 'fileUrl' not in request_json:
            return jsonify({'error': 'No file URL provided'}), 400, headers

        file_url = request_json['fileUrl']
        
        # Download the file content from URL
        print(f"Downloading file from URL: {file_url}")
        response = requests.get(file_url)
        if response.status_code != 200:
            error_msg = f"Failed to download file: Status {response.status_code}"
            print(error_msg)
            return jsonify({'error': error_msg}), 400, headers

        file_content = response.content
        if not file_content:
            error_msg = "Downloaded file is empty"
            print(error_msg)
            return jsonify({'error': error_msg}), 400, headers

        # Initialize Document AI client
        client = documentai.DocumentProcessorServiceClient()
        name = f"projects/{PROJECT_ID}/locations/{LOCATION}/processors/{PROCESSOR_ID}"

        # Create a raw document
        raw_document = documentai.RawDocument(
            content=file_content,
            mime_type='application/pdf'  # Adjust based on your file type
        )

        # Log before making the API call
        print(f"Making API call to Document AI with request: {name}")
        print(f"Document content length: {len(file_content)} bytes")

        request = documentai.ProcessRequest(
            name=name,
            raw_document=raw_document
        )

        result = client.process_document(request=request)

        # Log after the API call
        print("API call to Document AI completed successfully.")

        document = result.document
        text = document.text
        
        # Debug logging for Document AI output
        print("\n=== Document AI Processing Results ===")
        print(f"Text length: {len(text)} characters")
        print("First 500 characters of extracted text:")
        print(text[:500])
        print("\nDocument Metadata:")
        print(f"MIME type: {document.mime_type}")
        print(f"Page count: {len(document.pages)}")
        
        # Log entity extraction if available
        if document.entities:
            print("\nExtracted Entities:")
            for entity in document.entities:
                print(f"- Type: {entity.type_}, Confidence: {entity.confidence:.2f}")
                print(f"  Text: {entity.mention_text}")
        
        print("=== End Document AI Results ===\n")
        
        # Prepare data for Airtable
        airtable_data = {
            "fields": {
                "Document_AI_Response": text  # Store the response in the specified column
            }
        }

        # Send the response to Airtable
        airtable_url = f"https://api.airtable.com/v0/{AIRTABLE_BASE_ID}/{AIRTABLE_TABLE_NAME}"
        airtable_headers = {
            "Authorization": f"Bearer {AIRTABLE_API_KEY}",
            "Content-Type": "application/json"
        }
        
        print(f"Sending data to Airtable: {airtable_url}")
        print("Airtable request data:", json.dumps(airtable_data, indent=2))
        
        try:
            airtable_response = requests.post(airtable_url, headers=airtable_headers, json=airtable_data)
            print(f"Airtable response status: {airtable_response.status_code}")
            print(f"Airtable response body: {airtable_response.text}")
            
            if airtable_response.status_code == 200:
                print("Successfully pushed response to Airtable.")
            else:
                error_msg = f"Failed to push to Airtable: Status {airtable_response.status_code}, Response: {airtable_response.text}"
                print(error_msg)
                return jsonify({'error': error_msg}), 500, headers
                
        except requests.exceptions.RequestException as e:
            error_msg = f"Error making request to Airtable: {str(e)}"
            print(error_msg)
            return jsonify({'error': error_msg}), 500, headers

        return jsonify({
            'success': True,
            'text': text
        }), 200, headers

    except Exception as e:
        error_msg = f"Error processing document: {str(e)}"
        print(error_msg)  # Log the error message
        return jsonify({'error': error_msg}), 500, headers 