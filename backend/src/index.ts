// src/index.ts
import { Client } from "@neondatabase/serverless";
import { verifyToken } from "@clerk/backend";

// Helper: return JSON with CORS headers
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });

// Helper: return CORS preflight response
const corsResponse = () =>
  new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });

// Clerk JWT verification (RS256)
async function getUserId(req: Request, env: Env) {
  try {
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new Error("Missing or invalid Authorization header");
    }
    
    const token = authHeader.replace("Bearer ", "");
    if (!token) {
      throw new Error("Missing token");
    }
    
    const payload = await verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
    });
    
    if (!payload.sub) {
      throw new Error("Invalid token payload");
    }
    
    return payload.sub as string;
  } catch (err: any) {
    console.error("Authentication error:", err);
    throw new Error("Authentication failed: " + err.message);
  }
}

// Route dispatcher
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Initialize Neon connection with environment variables
    const sql = new Client(env.NEON_DATABASE_URL);
    
    try {
      await sql.connect();
    } catch (err) {
      console.error("Database connection failed:", err);
      return json({ error: "Database connection failed" }, 500);
    }

    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    try {
      // Handle CORS preflight requests
      if (method === "OPTIONS") {
        return corsResponse();
      }
      
      // Add a health check endpoint
      if (path === "/health" && method === "GET") {
        return json({ status: "ok", timestamp: new Date().toISOString() });
      }
      if (path === "/" && method === "GET") {
        return json({ status: "Server Running", message:"Can't access backend directly.", timestamp: new Date().toISOString() });
      }
      if (path === "/api/tasks" && method === "POST") {
        return await createTask(req, env, sql);
      }
      if (path === "/api/tasks" && method === "GET") {
        return await getTasks(req, env, sql);
      }
      if (path.startsWith("/api/tasks/") && method === "DELETE") {
        return await deleteTask(req, env, sql);
      }
      if (path === "/api/preferences" && method === "POST") {
        return await savePreferences(req, env, sql);
      }
      if (path === "/api/preferences" && method === "GET") {
        return await getPreferences(req, env, sql);
      }
      if (path === "/api/plan" && method === "POST") {
        return await generatePlan(req, env, sql);
      }
      if (path === "/api/plan" && method === "GET") {
        return await getPlan(req, env, sql);
      }
      if (path === "/api/weather" && method === "GET") {
        return await getWeather(req, env, sql);
      }
      if (path === "/api/apod" && method === "GET") {
        return await getApod(req, env);
      }
      return json({ error: "Not found" }, 404);
    } catch (err: any) {
      console.error("Request error:", err);
      return json({ error: err.message || "Server error" }, 500);
    } finally {
      // Close the connection safely
      try {
        await sql.end();
      } catch (err) {
        console.error("Error closing database connection:", err);
      }
    }
  },
};

// --- Handlers --------------------------------------------------
async function createTask(req: Request, env: Env, sql: Client) {
  const userId = await getUserId(req, env);
  
  // Ensure the user exists in the users table before creating tasks
  try {
    await sql.query(
      `INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [userId]
    );
  } catch (err) {
    console.error("Failed to create user record:", err);
    // Continue anyway, the user might already exist
  }
  
  let body;
  try {
    body = await req.json() as { title: string; duration: number; importance: string };
  } catch (err) {
    return json({ error: "Invalid JSON in request body" }, 400);
  }
  
  const { title, duration, importance } = body;
  
  // Validate required fields
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return json({ error: "Title is required and must be a non-empty string" }, 400);
  }
  
  if (!duration || typeof duration !== 'number' || duration <= 0) {
    return json({ error: "Duration is required and must be a positive number" }, 400);
  }
  
  if (!importance || typeof importance !== 'string') {
    return json({ error: "Importance is required and must be a string" }, 400);
  }
  
  try {
    await sql.query(
      `INSERT INTO tasks (user_id, title, duration_minutes, importance, task_date)
       VALUES ($1, $2, $3, $4, CURRENT_DATE)`,
      [userId, title.trim(), duration, importance]
    );
    return json({ ok: true, message: "Task created successfully" });
  } catch (err: any) {
    console.error("Database error creating task:", err);
    return json({ error: "Failed to create task: " + err.message }, 500);
  }
}

async function getPlan(req: Request, env: Env, sql: Client) {
  const userId = await getUserId(req, env);
  
  try {
    const { rows } = await sql.query(
      `SELECT plan_json FROM plans WHERE user_id = $1 AND plan_date = CURRENT_DATE`,
      [userId]
    );
    
    if (!rows.length) {
      return json({ plan: null, message: "No plan found for today" });
    }
    
    return json({ plan: rows[0].plan_json });
  } catch (err: any) {
    console.error("Database error getting plan:", err);
    return json({ error: "Failed to retrieve plan: " + err.message }, 500);
  }
}

async function generatePlan(req: Request, env: Env, sql: Client) {
  const userId = await getUserId(req, env);
  
  // Ensure the user exists in the users table before generating plan
  try {
    await sql.query(
      `INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [userId]
    );
  } catch (err) {
    console.error("Failed to create user record:", err);
    // Continue anyway, the user might already exist
  }
  
  // fetch prefs, tasks, events, weather, apod in parallel
  const [{ rows: prefsRows }, { rows: taskRows }] = await Promise.all([
    sql.query(`SELECT * FROM preferences WHERE user_id = $1`, [userId]),
    sql.query(`SELECT * FROM tasks WHERE user_id = $1 AND task_date = CURRENT_DATE`, [userId]),
  ]);
  
  const prefs = prefsRows[0];
  const tasks = taskRows;

  // Check if user has preferences
  if (!prefs) {
    return json({ error: "User preferences not found. Please set up your preferences first." }, 400);
  }

  // Check if user has tasks
  if (!tasks || tasks.length === 0) {
    return json({ error: "No tasks found for today. Please add some tasks first." }, 400);
  }

  let weather = null;
  let apod = null;

  try {
    // Weather (with error handling)
    if (prefs.city) {
      const weatherRes = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?q=${prefs.city}&units=metric&appid=${env.OPENWEATHER_KEY}`
      );
      if (weatherRes.ok) {
        weather = await weatherRes.json();
      } else {
        console.error("Weather API error:", weatherRes.status);
        weather = { weather: [{ description: "unknown" }], main: { temp: 20 } };
      }
    } else {
      weather = { weather: [{ description: "unknown" }], main: { temp: 20 } };
    }
  } catch (err) {
    console.error("Weather fetch error:", err);
    weather = { weather: [{ description: "unknown" }], main: { temp: 20 } };
  }

  try {
    // NASA APOD (optional, with error handling)
    const apodRes = await fetch(
      `https://api.nasa.gov/planetary/apod?api_key=${env.NASA_KEY}`
    );
    if (apodRes.ok) {
      apod = await apodRes.json();
    }
  } catch (err) {
    console.error("NASA APOD fetch error:", err);
    // Continue without APOD data
  }

  // Build prompt
  const prompt = buildPrompt({ prefs, tasks, weather });

  let plan = null;
  try {
    // Call MistralAI
    const mistralRes = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
      },
      body: JSON.stringify({
        model: "mistral-large-latest",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1000,
        temperature: 0.7,
      }),
    });

    if (!mistralRes.ok) {
      throw new Error(`MistralAI API error: ${mistralRes.status} ${mistralRes.statusText}`);
    }

    const ai = await mistralRes.json() as { choices: Array<{ message: { content: string } }> };
    
    if (!ai.choices || !ai.choices[0] || !ai.choices[0].message) {
      throw new Error("Invalid response from MistralAI");
    }

    try {
      const rawContent = ai.choices[0].message.content;
      plan = parseAIResponse(rawContent);
    } catch (parseErr) {
      console.error("Failed to parse MistralAI response:", ai.choices[0].message.content);
      throw new Error("Failed to parse AI response as JSON");
    }
  } catch (err: any) {
    console.error("MistralAI error:", err);
    return json({ error: "Failed to generate plan: " + err.message }, 500);
  }

  try {
    // Persist the plan
    await sql.query(
      `INSERT INTO plans (user_id, plan_date, plan_json)
       VALUES ($1, CURRENT_DATE, $2)
       ON CONFLICT (user_id, plan_date) DO UPDATE SET plan_json = EXCLUDED.plan_json`,
      [userId, plan]
    );
  } catch (err) {
    console.error("Failed to save plan:", err);
    // Still return the plan even if saving fails
  }

  return json({ plan, apod, weather });
}

async function savePreferences(req: Request, env: Env, sql: Client) {
  const userId = await getUserId(req, env);
  
  // Ensure the user exists in the users table before saving preferences
  try {
    await sql.query(
      `INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [userId]
    );
  } catch (err) {
    console.error("Failed to create user record:", err);
    // Continue anyway, the user might already exist
  }
  
  let body;
  try {
    body = await req.json() as { 
      wakeTime: string; 
      sleepTime: string;
      peakFocus: string;
      city: string; 
      breakStyle: string; 
      breakInterval: number;
      maxWorkHours: number;
      commuteMode: string; 
    };
  } catch (err) {
    return json({ error: "Invalid JSON in request body" }, 400);
  }
  
  const { wakeTime, sleepTime, peakFocus, city, breakStyle, breakInterval, maxWorkHours, commuteMode } = body;
  
  // Validate required fields
  if (!wakeTime || !sleepTime || !peakFocus || !city || !breakStyle || breakInterval === undefined || maxWorkHours === undefined || !commuteMode) {
    return json({ error: "All preference fields are required" }, 400);
  }
  
  // Validate commute mode values (must match database check constraint)
  const validCommuteModes = ['none', 'walk', 'bike', 'public', 'car'];
  if (!validCommuteModes.includes(commuteMode)) {
    return json({ error: `Invalid commute mode. Must be one of: ${validCommuteModes.join(', ')}` }, 400);
  }
  
  // Validate peak focus values (must match database check constraint)
  const validPeakFocus = ['morning', 'afternoon', 'evening'];
  if (!validPeakFocus.includes(peakFocus)) {
    return json({ error: `Invalid peak focus. Must be one of: ${validPeakFocus.join(', ')}` }, 400);
  }
  
  // Validate time format (HH:MM)
  const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
  if (!timeRegex.test(wakeTime)) {
    return json({ error: "Wake time must be in HH:MM format" }, 400);
  }
  if (!timeRegex.test(sleepTime)) {
    return json({ error: "Sleep time must be in HH:MM format" }, 400);
  }
  
  // Validate numeric values
  if (typeof breakInterval !== 'number' || breakInterval <= 0) {
    return json({ error: "Break interval must be a positive number" }, 400);
  }
  if (typeof maxWorkHours !== 'number' || maxWorkHours <= 0 || maxWorkHours > 24) {
    return json({ error: "Max work hours must be between 1 and 24" }, 400);
  }
  
  try {
    await sql.query(
      `INSERT INTO preferences (user_id, wake_time, sleep_time, peak_focus, city, break_style, break_interval_minutes, max_work_hours, commute_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id) DO UPDATE SET 
         wake_time = EXCLUDED.wake_time,
         sleep_time = EXCLUDED.sleep_time,
         peak_focus = EXCLUDED.peak_focus,
         city = EXCLUDED.city,
         break_style = EXCLUDED.break_style,
         break_interval_minutes = EXCLUDED.break_interval_minutes,
         max_work_hours = EXCLUDED.max_work_hours,
         commute_mode = EXCLUDED.commute_mode`,
      [userId, wakeTime, sleepTime, peakFocus, city, breakStyle, breakInterval, maxWorkHours, commuteMode]
    );
    return json({ ok: true, message: "Preferences saved successfully" });
  } catch (err: any) {
    console.error("Database error saving preferences:", err);
    return json({ error: "Failed to save preferences: " + err.message }, 500);
  }
}

async function getPreferences(req: Request, env: Env, sql: Client) {
  const userId = await getUserId(req, env);
  
  try {
    const { rows } = await sql.query(
      `SELECT wake_time, sleep_time, peak_focus, city, break_style, break_interval_minutes, max_work_hours, commute_mode FROM preferences WHERE user_id = $1`,
      [userId]
    );
    
    if (!rows.length) {
      return json({ preferences: null, message: "No preferences found" });
    }
    
    // Map the database response to match frontend expectations
    const prefs = rows[0];
    return json({ 
      preferences: {
        wakeTime: prefs.wake_time,
        sleepTime: prefs.sleep_time,
        peakFocus: prefs.peak_focus,
        city: prefs.city,
        breakStyle: prefs.break_style,
        breakInterval: prefs.break_interval_minutes,
        maxWorkHours: prefs.max_work_hours,
        commuteMode: prefs.commute_mode
      }
    });
  } catch (err: any) {
    console.error("Database error getting preferences:", err);
    return json({ error: "Failed to retrieve preferences: " + err.message }, 500);
  }
}

async function getTasks(req: Request, env: Env, sql: Client) {
  const userId = await getUserId(req, env);
  
  try {
    const { rows } = await sql.query(
      `SELECT id, title, duration_minutes, importance, task_date 
       FROM tasks 
       WHERE user_id = $1 AND task_date = CURRENT_DATE 
       ORDER BY id DESC`,
      [userId]
    );
    
    // Map database fields to frontend expectations
    const tasks = rows.map(task => ({
      id: task.id.toString(),
      title: task.title,
      duration: task.duration_minutes,
      importance: task.importance
    }));
    
    return json({ tasks });
  } catch (err: any) {
    console.error("Database error getting tasks:", err);
    return json({ error: "Failed to retrieve tasks: " + err.message }, 500);
  }
}

async function deleteTask(req: Request, env: Env, sql: Client) {
  const userId = await getUserId(req, env);
  const url = new URL(req.url);
  const taskId = url.pathname.split('/').pop();
  
  if (!taskId) {
    return json({ error: "Task ID is required" }, 400);
  }
  
  try {
    const result = await sql.query(
      `DELETE FROM tasks WHERE id = $1 AND user_id = $2`,
      [taskId, userId]
    );
    
    if (result.rowCount === 0) {
      return json({ error: "Task not found or not authorized to delete" }, 404);
    }
    
    return json({ ok: true, message: "Task deleted successfully" });
  } catch (err: any) {
    console.error("Database error deleting task:", err);
    return json({ error: "Failed to delete task: " + err.message }, 500);
  }
}

// --- Helpers ---------------------------------------------------
function buildPrompt({ prefs, tasks, weather }: any) {
  if (!tasks || tasks.length === 0) {
    throw new Error("No tasks provided for planning");
  }
  
  const taskLines = tasks
    .map((t: any) => `${t.title || 'Untitled'} – ${t.duration_minutes || 30}m – ${t.importance || 'medium'}`)
    .join("\n");
    
  const weatherDesc = weather?.weather?.[0]?.description || "unknown";
  const weatherTemp = weather?.main?.temp || "unknown";
  
  return `You are a personal day planning assistant. Create an optimized daily schedule in JSON format.

User preferences: ${JSON.stringify(prefs || {})}
Weather: ${weatherDesc}, ${weatherTemp}°C
Tasks to schedule:
${taskLines}

IMPORTANT: You must respond with COMPLETE, VALID JSON only. No markdown, no explanations, no comments.

Generate a JSON response with this EXACT structure:
{
  "schedule": [
    {
      "time": "HH:MM",
      "activity": "task or break name",
      "duration": "minutes",
      "type": "task|break|meal"
    }
  ],
  "summary": "Brief summary of the day plan"
}

Requirements:
- Include ALL closing brackets and braces
- Start with user's wake time (${prefs?.wake_time || '09:00'})
- Include breaks every ${prefs?.break_interval_minutes || 30} minutes
- Schedule all provided tasks
- End before sleep time (${prefs?.sleep_time || '23:00'})
- Return ONLY the JSON object, nothing else

Consider the weather, user preferences, task importance, and include appropriate breaks.`;
}

// Helper: parse AI response, handling markdown code blocks and extracting JSON
function parseAIResponse(rawContent: string): any {
  try {
    // First, try to parse directly
    return JSON.parse(rawContent);
  } catch {
    // If direct parsing fails, try to extract JSON from markdown code blocks
    let cleanedContent = rawContent.trim();
    
    // Remove markdown code block markers
    cleanedContent = cleanedContent
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/\s*```$/, '');
    
    // Try to find JSON-like content between braces
    const jsonMatch = cleanedContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleanedContent = jsonMatch[0];
    }
    
    // Fix common JSON issues
    cleanedContent = cleanedContent.trim();
    
    // If the JSON appears to be cut off, try to fix it
    if (cleanedContent.includes('"schedule"') && !cleanedContent.includes('"summary"')) {
      // Try to repair incomplete JSON
      const scheduleMatch = cleanedContent.match(/\{[\s\S]*"schedule":\s*\[[\s\S]*/);
      if (scheduleMatch) {
        let scheduleContent = scheduleMatch[0];
        
        // Count open and close brackets to see if we need to close the array/object
        const openBrackets = (scheduleContent.match(/\[/g) || []).length;
        const closeBrackets = (scheduleContent.match(/\]/g) || []).length;
        const openBraces = (scheduleContent.match(/\{/g) || []).length;
        const closeBraces = (scheduleContent.match(/\}/g) || []).length;
        
        // Remove trailing comma if present
        scheduleContent = scheduleContent.replace(/,\s*$/, '');
        
        // Close missing brackets and braces
        for (let i = closeBrackets; i < openBrackets; i++) {
          scheduleContent += ']';
        }
        
        // Add summary if missing
        if (!scheduleContent.includes('"summary"')) {
          scheduleContent += ', "summary": "Daily schedule generated based on your preferences and tasks."';
        }
        
        for (let i = closeBraces; i < openBraces; i++) {
          scheduleContent += '}';
        }
        
        cleanedContent = scheduleContent;
      }
    }
    
    // Try parsing the cleaned content
    try {
      return JSON.parse(cleanedContent);
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      console.error("Cleaned content:", cleanedContent);
      
      // Last resort: create a fallback response
      if (cleanedContent.includes('"schedule"')) {
        try {
          // Extract schedule items manually
          const scheduleItems = [];
          const timeMatches = cleanedContent.match(/"time":\s*"[^"]+"/g);
          const activityMatches = cleanedContent.match(/"activity":\s*"[^"]+"/g);
          const durationMatches = cleanedContent.match(/"duration":\s*"[^"]+"/g);
          const typeMatches = cleanedContent.match(/"type":\s*"[^"]+"/g);
          
          if (timeMatches && activityMatches && durationMatches && typeMatches) {
            const minLength = Math.min(timeMatches.length, activityMatches.length, durationMatches.length, typeMatches.length);
            for (let i = 0; i < minLength; i++) {
              scheduleItems.push({
                time: timeMatches[i].match(/"([^"]+)"/)?.[1] || "09:00",
                activity: activityMatches[i].match(/"([^"]+)"/)?.[1] || "Task",
                duration: durationMatches[i].match(/"([^"]+)"/)?.[1] || "30",
                type: typeMatches[i].match(/"([^"]+)"/)?.[1] || "task"
              });
            }
          }
          
          return {
            schedule: scheduleItems,
            summary: "Daily schedule generated based on your preferences and tasks."
          };
        } catch {
          // Ultimate fallback
          return {
            schedule: [
              { time: "09:00", activity: "Morning Task", duration: "60", type: "task" },
              { time: "10:00", activity: "Break", duration: "15", type: "break" },
              { time: "10:15", activity: "Work Session", duration: "90", type: "task" },
              { time: "11:45", activity: "Lunch", duration: "60", type: "meal" }
            ],
            summary: "Basic daily schedule created as fallback."
          };
        }
      }
      
      throw new Error(`Cannot extract valid JSON from AI response: ${rawContent.substring(0, 200)}...`);
    }
  }
}

async function getWeather(req: Request, env: Env, sql: Client) {
  const userId = await getUserId(req, env);
  
  try {
    // Get user's city from preferences
    const { rows } = await sql.query(
      `SELECT city FROM preferences WHERE user_id = $1`,
      [userId]
    );
    
    if (!rows.length || !rows[0].city) {
      return json({ error: "City not found in user preferences. Please set up your preferences first." }, 400);
    }
    
    const city = rows[0].city;
    
    try {
      const weatherRes = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&appid=${env.OPENWEATHER_KEY}`
      );
      
      if (!weatherRes.ok) {
        throw new Error(`Weather API error: ${weatherRes.status}`);
      }
      
      const weather = await weatherRes.json() as any;
      
      return json({
        temperature: `${Math.round(weather.main.temp)}°C`,
        condition: weather.weather[0].description,
        location: `${weather.name}, ${weather.sys.country}`,
        icon: weather.weather[0].icon,
        humidity: weather.main.humidity,
        windSpeed: weather.wind?.speed || 0
      });
    } catch (err: any) {
      console.error("Weather API error:", err);
      return json({ error: "Failed to fetch weather data: " + err.message }, 500);
    }
  } catch (err: any) {
    console.error("Database error getting weather:", err);
    return json({ error: "Failed to get weather: " + err.message }, 500);
  }
}

async function getApod(req: Request, env: Env) {
  try {
    const apodRes = await fetch(
      `https://api.nasa.gov/planetary/apod?api_key=${env.NASA_KEY}`
    );
    
    if (!apodRes.ok) {
      throw new Error(`NASA APOD API error: ${apodRes.status}`);
    }
    
    const apod = await apodRes.json() as any;
    
    return json({
      title: apod.title,
      description: apod.explanation,
      imageUrl: apod.url,
      date: apod.date,
      mediaType: apod.media_type
    });
  } catch (err: any) {
    console.error("NASA APOD API error:", err);
    return json({ error: "Failed to fetch NASA APOD data: " + err.message }, 500);
  }
}