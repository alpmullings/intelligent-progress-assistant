Using your API keys
You can use your API key with our JavaScript SDK or with direct HTTP calls:

JavaScript/TypeScript SDK (Recommended):
// Install: npm install viarag
import { ViaRAGClient } from 'viarag';

const client = new ViaRAGClient({
  apiKey: 'YOUR_API_KEY'
});

// Upload and embed document
const uploadResult = await client.uploadDocument(
  file, 
  'document.pdf',
  { source: 'upload' },
  { chunk_size: 1000, chunk_overlap: 200 }
);

// Query documents with RAG
const queryResult = await client.simpleQuery(
  'What is the main topic?', 
  5
);

// Search for context without generation
const contextMatches = await client.matchContext(
  'search term',
  10
);

// Direct LLM query (no retrieval)
const directResult = await client.directQuery(
  'Tell me about AI'
);
Direct HTTP (curl):
# Upload document
curl -X POST \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "file=@document.pdf" \
  -F "metadata={\"source\":\"upload\"}" \
  -F "chunking_config={\"chunk_size\":1000}" \
  https://viarag-backend-prod-104241861537.us-central1.run.app/api/v1/simple/upload

# Simple RAG query  
curl -X POST \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"What is the main topic?","top_k":5}' \
  https://viarag-backend-prod-104241861537.us-central1.run.app/api/v1/simple/query