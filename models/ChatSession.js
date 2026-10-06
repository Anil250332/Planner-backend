import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ['user', 'assistant'],
    required: true,
  },
  content: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

const tripPlanSchema = new mongoose.Schema({
  tripTitle: String,
  destination: String,
  duration: String,
  totalBudget: {
    amount: Number,
    currency: String,
    breakdown: {
      accommodation: Number,
      food: Number,
      transport: Number,
      activities: Number,
      shopping: Number,
      miscellaneous: Number,
    },
  },
  packingTips: [String],
  bestTimeToVisit: String,
  localTips: [String],
  emergencyContacts: {
    police: String,
    ambulance: String,
    touristHelpline: String,
  },
  dailyItinerary: [{
    day: Number,
    title: String,
    date: String,
    activities: [{
      time: String,
      activity: String,
      description: String,
      location: String,
      estimatedCost: String,
      duration: String,
      tips: String,
    }],
    meals: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    accommodation: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    transport: String,
    dayBudget: String,
  }],
}, { strict: false });

const chatSessionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
  },
  title: {
    type: String,
    default: 'New Trip Chat',
  },
  messages: [messageSchema],
  tripPlan: tripPlanSchema,
  tripDetails: {
    destination: String,
    startDate: String,
    endDate: String,
    budget: Number,
    currency: String,
    travelers: Number,
    interests: [String],
    travelStyle: String,
  },
  status: {
    type: String,
    enum: ['active', 'completed', 'archived'],
    default: 'active',
  },
  language: {
    type: String,
    enum: ['en', 'hi'],
    default: 'en',
  },
}, { timestamps: true });

const ChatSession = mongoose.model('ChatSession', chatSessionSchema);
export default ChatSession;
