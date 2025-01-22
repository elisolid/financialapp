// This is a script to be used in Airtable Automations

let config = input.config();
let table = base.getTable('Customer Financial Documents');

// Get the record that triggered the automation
let record = await table.selectRecordAsync(config.recordId);

// Get the attachment field
let attachments = record.getCellValue('Document');

if (attachments && attachments.length > 0) {
    // Get the first attachment's URL
    let fileUrl = attachments[0].url;
    
    // Call the Cloud Function
    let response = await fetch('https://us-central1-financial-app-448316.cloudfunctions.net/process_document', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            fileUrl: fileUrl
        })
    });
    
    let result = await response.json();
    
    // Update the record with the processed text
    if (result.success) {
        await table.updateRecordAsync(record, {
            'Processed_Text': result.text
        });
    }
} 