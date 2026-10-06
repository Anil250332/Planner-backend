import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import ChatSession from '../models/ChatSession.js';
import { optionalAuth } from '../middleware/auth.js';

const router = express.Router();

const CANDIDATE_MODELS = ['gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'];

const getAIClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('API_KEY_INVALID: Gemini API key is missing. Please set GEMINI_API_KEY in backend/.env');
  }
  return new GoogleGenerativeAI(apiKey.trim());
};

// System prompt for the travel AI
const getSystemPrompt = (language) => {
  const langInstruction = language === 'hi'
    ? 'The user prefers Hindi / Hinglish. Respond naturally in friendly Hindi or Hinglish (mix of Hindi & English) depending on how the user communicates. Keep it conversational, warm, and helpful.'
    : 'Respond in friendly, natural English. If the user writes to you in Hindi or Hinglish, feel free to respond in Hindi/Hinglish naturally.';

  return `You are TravelAI — an enthusiastic, knowledgeable, and friendly travel planning expert and buddy.

${langInstruction}

Your personality:
- Warm, excited, and knowledgeable like a well-traveled local friend.
- Use relevant emojis naturally.
- Give concrete, realistic suggestions with real attraction names, estimated costs in the requested currency (default INR ₹), local dishes, and commute tips.
- Ask friendly follow-up questions when the user gives vague requests (e.g. asking for preferred travel dates, budget range, group size, or travel style).

When to generate a complete trip plan JSON:
- During casual conversation or while gathering details, chat naturally like a human friend without outputting raw JSON.
- When the user explicitly asks for a complete itinerary, schedule, day-by-day plan, or when you have gathered all necessary details (destination, duration, budget/interests), provide your friendly explanation AND include a COMPLETE trip plan formatted as JSON wrapped in \`\`\`json ... \`\`\` code blocks with this EXACT structure:

\`\`\`json
{
  "tripTitle": "Catchy trip title",
  "destination": "Place name",
  "duration": "X Days, Y Nights",
  "totalBudget": {
    "amount": 15000,
    "currency": "INR",
    "breakdown": {
      "accommodation": 5000,
      "food": 4000,
      "transport": 3000,
      "activities": 2000,
      "shopping": 1000,
      "miscellaneous": 0
    }
  },
  "packingTips": ["tip1", "tip2", "tip3"],
  "bestTimeToVisit": "Best season description",
  "localTips": ["tip1", "tip2", "tip3"],
  "dailyItinerary": [
    {
      "day": 1,
      "title": "Day theme (e.g. Arrival & Beach Exploration)",
      "date": "Day 1",
      "activities": [
        {
          "time": "09:00 AM",
          "activity": "Activity name",
          "description": "Short description of what to do",
          "location": "Location name",
          "estimatedCost": "₹500",
          "duration": "2 hours",
          "tips": "Practical tip"
        }
      ],
      "meals": {
        "breakfast": { "restaurant": "Cafe name", "cuisine": "Local cuisine", "estimatedCost": "₹300" },
        "lunch": { "restaurant": "Restaurant name", "cuisine": "Thali / Seafood", "estimatedCost": "₹500" },
        "dinner": { "restaurant": "Dinner spot", "cuisine": "Dinner style", "estimatedCost": "₹700" }
      },
      "accommodation": {
        "name": "Stay or Hotel name",
        "type": "Hotel / Hostel / Resort",
        "estimatedCost": "₹2500/night",
        "area": "Area name"
      },
      "transport": "Scooter rental / Metro / Cab",
      "dayBudget": "₹4500"
    }
  ]
}
\`\`\`

Always ensure the JSON is 100% valid with no trailing commas.`;
};

// Build clean alternating history for Gemini chat
const buildGeminiHistory = (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  // Gemini requires the conversation history to begin with role: 'user'
  const firstUserIdx = messages.findIndex(m => m.role === 'user');
  if (firstUserIdx === -1) {
    return [];
  }

  const validMessages = messages.slice(firstUserIdx);
  const history = [];

  for (const msg of validMessages) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const text = (msg.content || '').trim();
    if (!text) continue;

    if (history.length > 0 && history[history.length - 1].role === role) {
      // Merge consecutive turns of the same role
      history[history.length - 1].parts[0].text += '\n\n' + text;
    } else {
      history.push({
        role,
        parts: [{ text }],
      });
    }
  }

  // If history ends with 'user', drop it because the upcoming sendMessage is the 'user' turn
  if (history.length > 0 && history[history.length - 1].role === 'user') {
    history.pop();
  }

  return history;
};

// Send message via Gemini with candidate model failover
const sendGeminiChatMessage = async (systemPrompt, history, userMessage) => {
  const genAI = getAIClient();
  let lastError = null;

  for (const modelName of CANDIDATE_MODELS) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemPrompt,
      });

      const chat = model.startChat({ history });
      const result = await chat.sendMessage(userMessage);
      const text = result.response.text();
      if (text) {
        return { text, modelName };
      }
    } catch (err) {
      console.warn(`Model ${modelName} chat error:`, err.message);
      lastError = err;
    }
  }

  throw lastError || new Error('All Gemini candidate models failed to generate response');
};

// Quick plan generation with candidate model failover & JSON response mode
const generateGeminiJsonPlan = async (prompt) => {
  const genAI = getAIClient();
  let lastError = null;

  for (const modelName of CANDIDATE_MODELS) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: { responseMimeType: 'application/json' },
      });

      const result = await model.generateContent(prompt);
      const text = result.response.text();
      if (text) {
        const cleaned = text.trim();
        return JSON.parse(cleaned);
      }
    } catch (err) {
      console.warn(`Quick plan model ${modelName} error:`, err.message);
      lastError = err;
    }
  }

  throw lastError || new Error('All Gemini candidate models failed for quick plan');
};

// Safely extract trip plan JSON from markdown
const extractTripPlan = (aiText) => {
  if (!aiText) return null;
  const jsonMatch = aiText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const potentialJson = jsonMatch ? jsonMatch[1].trim() : null;

  if (potentialJson) {
    try {
      const parsed = JSON.parse(potentialJson);
      if (parsed && (parsed.tripTitle || parsed.dailyItinerary || parsed.destination)) {
        return parsed;
      }
    } catch (e) {
      try {
        const cleaned = potentialJson.replace(/,\s*([\]}])/g, '$1');
        const parsed = JSON.parse(cleaned);
        if (parsed && (parsed.tripTitle || parsed.dailyItinerary || parsed.destination)) {
          return parsed;
        }
      } catch (e2) {}
    }
  }

  const braceMatch = aiText.match(/(\{[\s\S]*"dailyItinerary"[\s\S]*\})/);
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch[1]);
      if (parsed && (parsed.tripTitle || parsed.dailyItinerary)) {
        return parsed;
      }
    } catch (e) {}
  }

  return null;
};

// Smart fallback if API is unreachable
const generateFallbackResponse = (userMsg, language) => {
  const isHindi = language === 'hi';
  const lower = (userMsg || '').toLowerCase();
  const isAskingPlan = lower.includes('plan') || lower.includes('itinerary') || lower.includes('budget') ||
    lower.includes('trip') || lower.includes('ghoom') || lower.includes('jana') || lower.includes('visit') ||
    lower.includes('days') || lower.includes('hotel') || lower.includes('tour');

  if (!isAskingPlan) {
    if (isHindi) {
      return `नमस्ते! 👋 मैं TravelAI हूं। आप किस जगह घूमने का plan बना रहे हैं? मुझे अपनी पसंदीदा destination, तारीखें, budget या travel style बताइए, और मैं आपके लिए एक शानदार personalized trip plan तैयार करूंगा! ✨`;
    }
    return `Hello! 👋 I'm TravelAI, your travel planning companion. Where are you dreaming of going? Tell me your destination, dates, budget, or preferred travel style, and I'll create a customized day-by-day itinerary with full budget details for you! ✨`;
  }

  const destMatch = userMsg.match(/(goa|manali|jaipur|kerala|paris|delhi|mumbai|shimla|ladakh|udaipur|agra|bali|tokyo|london|dubai|kashmir|rishikesh|ooty)/i);
  const dest = destMatch ? destMatch[0].toUpperCase() : 'Your Destination';

  const planObj = {
    tripTitle: `Ultimate ${dest} Adventure`,
    destination: dest,
    duration: '3 Days, 2 Nights',
    totalBudget: {
      amount: 15000,
      currency: 'INR',
      breakdown: {
        accommodation: 6000,
        food: 4000,
        transport: 3000,
        activities: 1500,
        shopping: 500,
        miscellaneous: 0,
      },
    },
    packingTips: [
      'Comfortable walking shoes & light cotton clothing',
      'Sunscreen, sunglasses & reusable water bottle',
      'Camera & power bank for photos',
      'Personal medicine kit & emergency cash',
    ],
    bestTimeToVisit: 'October to March for pleasant weather and local sightseeing.',
    localTips: [
      'Use local public transport or auto-rickshaws for quick commuting.',
      'Try authentic local street food at top-rated spots.',
      'Carry light woolens for evening strolls.',
    ],
    dailyItinerary: [
      {
        day: 1,
        title: `Arrival & Exploring ${dest}`,
        date: 'Day 1',
        activities: [
          { time: '09:00 AM', activity: `Arrival at ${dest}`, description: 'Hotel check-in and fresh up', location: dest, estimatedCost: '₹0', duration: '2 hours', tips: 'Keep ID proofs handy' },
          { time: '02:00 PM', activity: 'Famous Local Landmark Tour', description: 'Explore top heritage & cultural attractions', location: `${dest} Center`, estimatedCost: '₹500', duration: '3 hours', tips: 'Best time for photos' },
          { time: '07:00 PM', activity: 'Evening Street Market Walk', description: 'Shop local handicrafts & try street snacks', location: 'Main Market', estimatedCost: '₹1000', duration: '2 hours', tips: 'Bargaining recommended' },
        ],
        meals: {
          breakfast: { restaurant: 'Local Cafe', cuisine: 'Breakfast & Tea', estimatedCost: '₹300' },
          lunch: { restaurant: 'Heritage Restaurant', cuisine: 'Local Specialties', estimatedCost: '₹600' },
          dinner: { restaurant: 'Roof Top Grill', cuisine: 'Multi-cuisine', estimatedCost: '₹800' },
        },
        accommodation: { name: 'Grand View Resort / Boutique Stay', type: 'Hotel', estimatedCost: '₹2500/night', area: 'Central' },
        transport: 'Auto-rickshaw / Taxi',
        dayBudget: '₹4700',
      },
      {
        day: 2,
        title: 'Sightseeing & Nature Excursion',
        date: 'Day 2',
        activities: [
          { time: '08:30 AM', activity: 'Scenic Nature & Viewpoint Excursion', description: 'Enjoy sunrise views and scenic nature walk', location: `${dest} Viewpoint`, estimatedCost: '₹300', duration: '4 hours', tips: 'Carry water bottle' },
          { time: '03:00 PM', activity: 'Museum & Art Gallery Visit', description: 'Discover local culture & rich history', location: 'Culture Hub', estimatedCost: '₹400', duration: '2.5 hours', tips: 'Guided tour available' },
        ],
        meals: {
          breakfast: { restaurant: 'Baker & Co.', cuisine: 'Pastries & Coffee', estimatedCost: '₹250' },
          lunch: { restaurant: 'Traditional Thali Spot', cuisine: 'Regional Feast', estimatedCost: '₹550' },
          dinner: { restaurant: 'Sunset Lounge', cuisine: 'Local Specialties', estimatedCost: '₹900' },
        },
        accommodation: { name: 'Grand View Resort / Boutique Stay', type: 'Hotel', estimatedCost: '₹2500/night', area: 'Central' },
        transport: 'Private Cab',
        dayBudget: '₹4900',
      },
    ],
  };

  const textReply = isHindi
    ? `यहाँ आपका ${dest} का complete personalized trip plan है! ✈️🎉\n\nBudget, hotel options, daily schedule aur packing tips sab niche itinerary me ready hain.`
    : `Here is your complete personalized trip plan for ${dest}! ✈️🎉\n\nI have detailed the budget breakdown, daily schedule, restaurant picks, and packing advice below. Enjoy your trip!`;

  return `${textReply}\n\n\`\`\`json\n${JSON.stringify(planObj, null, 2)}\n\`\`\``;
};

// Create new chat session
router.post('/sessions', optionalAuth, async (req, res) => {
  try {
    const { language } = req.body;
    const lang = language === 'hi' ? 'hi' : 'en';

    const session = await ChatSession.create({
      user: req.user?._id || null,
      language: lang,
      messages: [{
        role: 'assistant',
        content: lang === 'hi'
          ? 'नमस्ते! 👋 मैं TravelAI हूं, आपका पर्सनल ट्रैवल बडी! 🌍✈️\n\nबताइए, आप कहां घूमने का plan बना रहे हैं? मैं आपकी पूरी trip plan करने में help करूंगा — budget, hotels, sights से लेकर daily schedule तक सब कुछ! 😊'
          : "Hey there! 👋 I'm TravelAI, your personal travel planner & buddy! 🌍✈️\n\nTell me, where are you dreaming of going? I'll help you plan the perfect trip — from budget to day-by-day itinerary, I've got you covered! 😊",
      }],
    });

    res.status(201).json({ success: true, session });
  } catch (error) {
    console.error('Create session error:', error);
    res.status(500).json({ error: 'Failed to create session.' });
  }
});

// Get all sessions for user
router.get('/sessions', optionalAuth, async (req, res) => {
  try {
    if (!req.user) {
      return res.json({ success: true, sessions: [] });
    }
    const sessions = await ChatSession.find({ user: req.user._id })
      .sort({ updatedAt: -1 })
      .select('title status language tripDetails createdAt updatedAt');

    res.json({ success: true, sessions });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sessions.' });
  }
});

// Get single session with messages
router.get('/sessions/:id', optionalAuth, async (req, res) => {
  try {
    const query = req.user
      ? { _id: req.params.id, $or: [{ user: req.user._id }, { user: null }] }
      : { _id: req.params.id };

    const session = await ChatSession.findOne(query);

    if (!session) {
      return res.status(404).json({ error: 'Session not found.' });
    }

    res.json({ success: true, session });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch session.' });
  }
});

// Send message in a session
router.post('/sessions/:id/message', optionalAuth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Message cannot be empty.' });
    }

    const query = req.user
      ? { _id: req.params.id, $or: [{ user: req.user._id }, { user: null }] }
      : { _id: req.params.id };

    const session = await ChatSession.findOne(query);

    if (!session) {
      return res.status(404).json({ error: 'Session not found.' });
    }

    // Capture prior messages before appending this new user message
    const priorMessages = session.messages.map(m => ({ role: m.role, content: m.content }));

    // Append new user message to session
    session.messages.push({ role: 'user', content: message.trim() });

    // Prepare valid history for Gemini startChat
    const history = buildGeminiHistory(priorMessages);

    // Call Gemini with model failover
    let aiResponse = '';
    try {
      const systemPrompt = getSystemPrompt(session.language);
      const result = await sendGeminiChatMessage(systemPrompt, history, message.trim());
      aiResponse = result.text;
    } catch (apiErr) {
      console.warn('Gemini chat call failed, falling back:', apiErr.message);
      aiResponse = generateFallbackResponse(message.trim(), session.language);
    }

    // Append AI response
    session.messages.push({ role: 'assistant', content: aiResponse });

    // Try to extract trip plan from response if it contains JSON
    const planData = extractTripPlan(aiResponse);
    if (planData) {
      session.tripPlan = planData;
      session.title = planData.tripTitle || session.title;
      session.status = 'completed';
      if (planData.destination) {
        session.tripDetails = {
          ...session.tripDetails,
          destination: planData.destination,
        };
      }
    }

    // Auto-update title from first user message if title is default
    if (session.title === 'New Trip Chat' && session.messages.length >= 3) {
      const firstUserMsg = session.messages.find(m => m.role === 'user');
      if (firstUserMsg) {
        session.title = firstUserMsg.content.substring(0, 60) + (firstUserMsg.content.length > 60 ? '...' : '');
      }
    }

    await session.save();

    res.json({
      success: true,
      reply: aiResponse,
      tripPlan: session.tripPlan || null,
      sessionTitle: session.title,
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message || 'Failed to process request.' });
  }
});

// Direct Voice message endpoint (receives base64 audio recorded by browser)
router.post('/sessions/:id/voice-message', optionalAuth, async (req, res) => {
  try {
    const { audio, mimeType } = req.body;
    if (!audio) {
      return res.status(400).json({ error: 'Audio data is required.' });
    }

    const query = req.user
      ? { _id: req.params.id, $or: [{ user: req.user._id }, { user: null }] }
      : { _id: req.params.id };

    const session = await ChatSession.findOne(query);
    if (!session) {
      return res.status(404).json({ error: 'Session not found.' });
    }

    const genAI = getAIClient();
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: getSystemPrompt(session.language),
    });

    const prompt = `Listen carefully to the user's spoken audio message.
1. Transcribe what the user said (English, Hindi, or Hinglish).
2. As TravelAI (friendly travel assistant), answer the user warmly and helpfully.
Return ONLY valid JSON:
{
  "userTranscript": "accurate transcript of user audio",
  "reply": "your complete friendly response to the user"
}`;

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: mimeType || 'audio/webm',
          data: audio,
        },
      },
      { text: prompt },
    ]);

    let responseText = result.response.text().trim();
    let userTranscript = 'Voice message';
    let aiResponse = responseText;

    try {
      const cleaned = responseText.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed.reply) {
        aiResponse = parsed.reply;
      }
      if (parsed.userTranscript) {
        userTranscript = parsed.userTranscript;
      }
    } catch (e) {
      // If direct text was returned
    }

    session.messages.push({ role: 'user', content: userTranscript });
    session.messages.push({ role: 'assistant', content: aiResponse });

    const planData = extractTripPlan(aiResponse);
    if (planData) {
      session.tripPlan = planData;
      session.title = planData.tripTitle || session.title;
      session.status = 'completed';
    }

    if (session.title === 'New Trip Chat' && userTranscript) {
      session.title = userTranscript.substring(0, 50);
    }

    await session.save();

    res.json({
      success: true,
      userTranscript,
      reply: aiResponse,
      tripPlan: session.tripPlan || null,
      sessionTitle: session.title,
    });
  } catch (error) {
    console.error('Voice message error:', error);
    res.status(500).json({ error: error.message || 'Failed to process voice audio.' });
  }
});

// Quick plan generation (form-based)
router.post('/quick-plan', optionalAuth, async (req, res) => {
  try {
    const { destination, startDate, endDate, budget, currency, travelers, interests, travelStyle, language } = req.body;

    if (!destination) {
      return res.status(400).json({ error: 'Destination is required.' });
    }

    const lang = language === 'hi' ? 'hi' : 'en';
    const langInstruction = lang === 'hi'
      ? 'Generate all plan text and descriptions in natural Hinglish/Hindi.'
      : 'Generate all plan text and descriptions in English.';

    const prompt = `You are TravelAI. Generate a comprehensive travel plan. ${langInstruction}

Destination: ${destination}
Dates: ${startDate || 'Flexible'} to ${endDate || 'Flexible'}
Budget: ${budget || '15000'} ${currency || 'INR'}
Travelers: ${travelers || 2}
Interests: ${interests || 'Sightseeing, Food, Culture'}
Style: ${travelStyle || 'Balanced'}

Return ONLY a valid JSON object matching this schema:
{
  "tripTitle": "Catchy title",
  "destination": "${destination}",
  "duration": "X Days, Y Nights",
  "totalBudget": {
    "amount": ${Number(budget) || 15000},
    "currency": "${currency || 'INR'}",
    "breakdown": { "accommodation": 0, "food": 0, "transport": 0, "activities": 0, "shopping": 0, "miscellaneous": 0 }
  },
  "packingTips": ["tip1", "tip2", "tip3", "tip4"],
  "bestTimeToVisit": "Best time description",
  "localTips": ["tip1", "tip2", "tip3"],
  "dailyItinerary": [
    {
      "day": 1,
      "title": "Day Theme",
      "date": "${startDate || 'Day 1'}",
      "activities": [
        { "time": "09:00 AM", "activity": "Activity name", "description": "Brief description", "location": "Location", "estimatedCost": "₹500", "duration": "2h", "tips": "Helpful tip" }
      ],
      "meals": {
        "breakfast": { "restaurant": "Cafe name", "cuisine": "Cuisine", "estimatedCost": "₹300" },
        "lunch": { "restaurant": "Lunch spot", "cuisine": "Cuisine", "estimatedCost": "₹500" },
        "dinner": { "restaurant": "Dinner spot", "cuisine": "Cuisine", "estimatedCost": "₹800" }
      },
      "accommodation": { "name": "Hotel/Resort name", "type": "Hotel", "estimatedCost": "₹2500/night", "area": "Central area" },
      "transport": "Scooter / Cab / Metro",
      "dayBudget": "₹4500"
    }
  ]
}`;

    let plan;
    try {
      plan = await generateGeminiJsonPlan(prompt);
    } catch (apiErr) {
      console.warn('Quick plan Gemini API failed, using fallback plan generator:', apiErr.message);
      const fallbackStr = generateFallbackResponse(`Plan a trip to ${destination}`, lang);
      plan = extractTripPlan(fallbackStr) || {};
    }

    // Save as a completed session
    const session = await ChatSession.create({
      user: req.user?._id || null,
      title: plan.tripTitle || `Trip to ${destination}`,
      language: lang,
      tripPlan: plan,
      tripDetails: {
        destination,
        startDate,
        endDate,
        budget: Number(budget) || 15000,
        currency: currency || 'INR',
        travelers: Number(travelers) || 2,
        interests: typeof interests === 'string' ? interests.split(',').map(s => s.trim()) : (interests || []),
        travelStyle,
      },
      status: 'completed',
      messages: [
        { role: 'user', content: `Plan a trip to ${destination} from ${startDate || 'Day 1'} to ${endDate || 'Day 3'} with budget ${budget || '15000'} ${currency || 'INR'}` },
        { role: 'assistant', content: `Here's your personalized trip plan for ${destination}! 🎉\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`` },
      ],
    });

    res.json({ success: true, plan, sessionId: session._id });
  } catch (error) {
    console.error('Quick plan error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate plan. Please try again.' });
  }
});

// Delete session
router.delete('/sessions/:id', optionalAuth, async (req, res) => {
  try {
    await ChatSession.findOneAndDelete({
      _id: req.params.id,
    });
    res.json({ success: true, message: 'Session deleted.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete session.' });
  }
});

export default router;
