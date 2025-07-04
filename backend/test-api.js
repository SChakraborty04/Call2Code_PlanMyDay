// Simple test script to check API endpoints
async function testAPI() {
  const baseURL = 'http://127.0.0.1:8787';
  
  console.log('Testing health endpoint...');
  try {
    const response = await fetch(`${baseURL}/health`);
    const data = await response.json();
    console.log('Health check:', data);
  } catch (error) {
    console.error('Health check failed:', error.message);
  }
  
  console.log('\nTesting invalid endpoint...');
  try {
    const response = await fetch(`${baseURL}/invalid`);
    const data = await response.json();
    console.log('Invalid endpoint response:', data);
  } catch (error) {
    console.error('Invalid endpoint test failed:', error.message);
  }
}

testAPI();
