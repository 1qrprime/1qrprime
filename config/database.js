const mongoose = require('mongoose');

let isConnected = false;
let connectionPromise = null;

const connectDB = async () => {
  // If already connected, return
  if (isConnected && mongoose.connection.readyState === 1) {
    return;
  }

  // If connection is in progress, wait for it
  if (connectionPromise) {
    return connectionPromise;
  }

  // Check if MongoDB URI is set
  if (!process.env.MONGODB_URI) {
    const error = new Error('MONGODB_URI not set');
    console.error('❌ MongoDB connection error:', error.message);
    console.error('   Please set MONGODB_URI in Vercel environment variables');
    throw error;
  }

  // Create connection promise
  connectionPromise = (async () => {
    try {
      console.log('🔄 Attempting MongoDB connection...');
      console.log('   URI:', process.env.MONGODB_URI.replace(/:[^:@]+@/, ':****@')); // Hide password
      
      const conn = await mongoose.connect(process.env.MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 10000, // Increased to 10s for Vercel
        socketTimeoutMS: 45000,
        maxPoolSize: 10,
        retryWrites: true,
      });
      
      isConnected = true;
      console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
      console.log(`   Database: ${conn.connection.name}`);
      
      // Handle connection events
      mongoose.connection.on('error', (err) => {
        console.error('❌ MongoDB connection error:', err.message);
        isConnected = false;
      });
      
      mongoose.connection.on('disconnected', () => {
        console.warn('⚠️  MongoDB disconnected');
        isConnected = false;
      });
      
      mongoose.connection.on('reconnected', () => {
        console.log('✅ MongoDB reconnected');
        isConnected = true;
      });
      
      return conn;
    } catch (error) {
      isConnected = false;
      connectionPromise = null;
      
      console.error('❌ MongoDB connection failed:');
      console.error('   Error:', error.message);
      console.error('   Code:', error.code);
      
      // Provide helpful error messages
      if (error.message.includes('authentication failed')) {
        console.error('   💡 Check: MongoDB username/password in MONGODB_URI');
      } else if (error.message.includes('ENOTFOUND') || error.message.includes('getaddrinfo')) {
        console.error('   💡 Check: MongoDB cluster hostname is correct');
      } else if (error.message.includes('timeout') || error.message.includes('ETIMEDOUT')) {
        console.error('   💡 Check: MongoDB Atlas Network Access - whitelist 0.0.0.0/0');
        console.error('   💡 Check: Vercel IPs are allowed in MongoDB Atlas');
      } else if (error.message.includes('IP')) {
        console.error('   💡 Check: MongoDB Atlas Network Access - add 0.0.0.0/0');
      }
      
      // Don't exit - allow server to run (login/DB features will fail, but pages load)
      if (process.env.VERCEL) {
        console.error('   ⚠️  Running in Vercel - will retry on next request');
      } else {
        console.error('   ⚠️  Local dev: server will run but login/dashboard will fail until MongoDB connects');
      }
      
      return null; // Don't throw - allow server to stay up
    }
  })();
  
  return connectionPromise;
};

module.exports = connectDB;

