const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const connectDB = require('../config/database');
const User = require('../models/User');
const Link = require('../models/Link');
const multer = require('multer');
const path = require('path');

// Note: We use strict file size limits (100KB) instead of compression
// This is simpler, more reliable, and works everywhere (including Vercel)
// Users must compress images before uploading - saves storage costs

// Ensure DB connection for serverless
router.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error('Dashboard DB connection error:', error.message);
    // Don't crash - continue anyway, routes will handle DB errors individually
    next();
  }
});

// Configure multer with MEMORY storage (Vercel has read-only filesystem)
// Strict size limit: 100KB max (saves storage, works everywhere, no compression needed)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 }, // 100KB max - strict limit for cost savings
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|svg|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = file.mimetype.startsWith('image/');
    
    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'));
    }
  }
});

// Helper function to convert image to base64 data URL
// Simple approach: Multer already enforces 100KB limit, so we just convert to base64
// No compression needed - files are already small enough
async function compressAndConvertToDataUrl(buffer, mimetype) {
  try {
    // Multer already enforces 100KB limit, so file is guaranteed to be small
    // Just convert to base64 - simple, reliable, works everywhere
    return `data:${mimetype};base64,${buffer.toString('base64')}`;
  } catch (error) {
    console.error('Image conversion error:', error);
    throw new Error('Failed to process image. Please try again.');
  }
}

// Legacy function for backward compatibility (for custom icons)
function bufferToDataUrl(buffer, mimetype) {
  return `data:${mimetype};base64,${buffer.toString('base64')}`;
}

// Default categories with icons
// Payment uses Cred logo image URL
const DEFAULT_CATEGORIES = {
  instagram: { icon: 'fab fa-instagram', name: 'Instagram', color: 'gradient' },
  facebook: { icon: 'fab fa-facebook', name: 'Facebook', color: '#1877F2' },
  whatsapp: { icon: 'fab fa-whatsapp', name: 'WhatsApp', color: '#25D366' },
  payment: { icon: '/images/cred-icon.png', name: 'Payment', color: '#25D366', isImage: true },
  website: { icon: 'fas fa-globe', name: 'Website', color: '#4285F4' },
  google: { icon: 'fab fa-google', name: 'Google Reviews', color: '#EA4335' },
  maps: { icon: 'fas fa-map-marker-alt', name: 'Google Maps', color: '#4285F4' },
  menu: { icon: 'fas fa-utensils', name: 'Menu Card', color: '#FF6B6B' },
  bar: { icon: 'fas fa-cocktail', name: 'Bar', color: '#FFB800' },
  products: { icon: 'fas fa-shopping-bag', name: 'Products', color: '#9C27B0' },
  // Generic services icon (briefcase) to represent any service type
  services: { icon: 'fas fa-briefcase', name: 'Services', color: '#FF9800' },
  youtube: { icon: 'fab fa-youtube', name: 'YouTube', color: '#FF0000' },
  twitter: { icon: 'fab fa-twitter', name: 'Twitter', color: '#1DA1F2' },
  linkedin: { icon: 'fab fa-linkedin', name: 'LinkedIn', color: '#0077B5' }
};

// Dashboard page
router.get('/', auth, async (req, res) => {
  try {
    // Check if req.user exists
    if (!req.user || !req.user._id) {
      console.error('Dashboard: req.user is missing or invalid');
      req.logout((err) => {
        if (err) console.error('Logout error:', err);
      });
      return res.redirect('/login');
    }
    
    // Check if req.user is actually a User (not an Admin)
    // Admins have 'role' field, Users don't (or have 'uniqueSlug'/'businessName')
    if (req.user.role) {
      // Admin trying to access user dashboard - redirect to admin dashboard
      return res.redirect('/admin');
    }
    
    // Ensure req.user is a User document - always fetch fresh from DB to ensure it's a User
    const user = await User.findById(req.user._id);
    if (!user) {
      // User not found - might be an Admin ID or deleted user
      console.error('Dashboard: User not found for ID:', req.user._id);
      req.logout((err) => {
        if (err) console.error('Logout error:', err);
      });
      return res.redirect('/login');
    }
    
    // Check if profile is complete - redirect to complete profile if not
    const isProfileComplete = user.businessName && user.businessName.trim() !== '' && 
                              user.phoneNumber && user.phoneNumber.trim() !== '';
    
    if (!isProfileComplete) {
      return res.redirect('/complete-profile');
    }
    
    const links = await Link.find({ userId: user._id, isActive: true }).sort({ order: 1 });
    
    res.render('dashboard', {
      user,
      links,
      defaultCategories: DEFAULT_CATEGORIES,
      baseUrl: process.env.BASE_URL || 'http://localhost:4000'
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    console.error('Error stack:', error.stack);
    console.error('req.user:', req.user ? { _id: req.user._id, email: req.user.email, role: req.user.role } : 'null');
    res.status(500).send('Error loading dashboard');
  }
});

// Update business name and logo (logo is optional)
// Error handler for multer file size errors
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ 
        success: false, 
        message: 'File size too large. Maximum size is 100KB. Please compress your image.' 
      });
    }
    return res.status(400).json({ 
      success: false, 
      message: 'File upload error: ' + err.message 
    });
  }
  if (err) {
    return res.status(400).json({ 
      success: false, 
      message: 'File upload error: ' + err.message 
    });
  }
  next();
};

router.post('/update-profile', auth, upload.fields([{ name: 'logo', maxCount: 1 }, { name: 'bankQrCode', maxCount: 1 }]), handleMulterError, async (req, res) => {
  try {
    // Check authentication
    if (!req.user || !req.user._id) {
      console.error('Profile update: User not authenticated', { 
        isAuthenticated: req.isAuthenticated(),
        user: req.user 
      });
      return res.status(403).json({ success: false, message: 'Authentication required' });
    }

    const { businessName, phoneNumber, address, upiId, upiPayeeName, upiAid, paymentLink, showCallButton, showDownloadButton, showPaymentDetails } = req.body;
    const logoFile = req.files && req.files['logo'] ? req.files['logo'][0] : null;
    const bankQrCodeFile = req.files && req.files['bankQrCode'] ? req.files['bankQrCode'][0] : null;
    const user = await User.findById(req.user._id);
    
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    // Update profile fields - allow all fields to be editable, including empty values
    if (businessName !== undefined) user.businessName = businessName || '';
    if (phoneNumber !== undefined) user.phoneNumber = phoneNumber || '';
    if (address !== undefined) user.address = address || '';
    // Handle showCallButton checkbox - if undefined, it means unchecked (false)
    // Checkbox sends 'on' when checked, or is undefined when unchecked
    if (showCallButton !== undefined) {
      user.showCallButton = showCallButton === 'true' || showCallButton === true || showCallButton === 'on';
    } else {
      // If checkbox is not in request (unchecked), set to false
      user.showCallButton = false;
    }
    
    // Handle showDownloadButton checkbox
    if (showDownloadButton !== undefined) {
      user.showDownloadButton = showDownloadButton === 'true' || showDownloadButton === true || showDownloadButton === 'on';
    } else {
      user.showDownloadButton = false;
    }
    
    // Handle showPaymentDetails checkbox
    if (showPaymentDetails !== undefined) {
      user.showPaymentDetails = showPaymentDetails === 'true' || showPaymentDetails === true || showPaymentDetails === 'on';
    } else {
      user.showPaymentDetails = false;
    }
    
    // Handle UPI ID - extract aid parameter if present in full URL
    if (upiId !== undefined) {
      let extractedUpiId = upiId || '';
      let extractedAid = '';
      
      // First, check if the original UPI ID contains an aid parameter
      const aidMatch = upiId.match(/[&?]aid=([^&]+)/i);
      if (aidMatch) {
        extractedAid = decodeURIComponent(aidMatch[1]);
      }
      
      // If UPI ID is a full URL, extract the UPI ID from pa= parameter
      if (extractedUpiId.includes('pa=')) {
        const paMatch = extractedUpiId.match(/pa=([^&]+)/i);
        if (paMatch) {
          extractedUpiId = decodeURIComponent(paMatch[1]);
        }
      } else if (extractedAid) {
        // If we found aid but UPI ID is not a full URL, try to clean it up
        // Remove aid and any other URL parameters from the UPI ID
        extractedUpiId = extractedUpiId.replace(/[&?]aid=[^&]*/i, '').replace(/[&?].*/, '').trim();
      }
      
      user.upiId = extractedUpiId;
      
      // If aid was extracted from UPI ID, save it (unless upiAid was explicitly provided)
      if (extractedAid && (!upiAid || upiAid === '')) {
        user.upiAid = extractedAid;
      }
    }
    
    if (upiPayeeName !== undefined) user.upiPayeeName = upiPayeeName || '';
    if (upiAid !== undefined) user.upiAid = upiAid || '';
    if (paymentLink !== undefined) user.paymentLink = paymentLink || '';
    
    // Store logo as base64 data URL in MongoDB
    // Multer already enforces 100KB limit, so file is guaranteed to be small
    if (logoFile) {
      try {
        // Check file size before processing
        if (logoFile.size > 100 * 1024) {
          console.warn('Logo file size exceeds limit:', logoFile.size);
          return res.status(400).json({ 
            success: false, 
            message: 'Logo file is too large. Maximum size is 100KB. Please compress your image.' 
          });
        }
        user.logo = await compressAndConvertToDataUrl(logoFile.buffer, logoFile.mimetype);
      } catch (logoError) {
        console.error('Logo processing error:', logoError);
        return res.status(400).json({ 
          success: false, 
          message: 'Error processing logo: ' + (logoError.message || 'Unknown error') 
        });
      }
    }
    
    // Store bank QR code as base64 data URL in MongoDB
    if (bankQrCodeFile) {
      try {
        // Check file size before processing
        if (bankQrCodeFile.size > 100 * 1024) {
          console.warn('Bank QR code file size exceeds limit:', bankQrCodeFile.size);
          return res.status(400).json({ 
            success: false, 
            message: 'QR code file is too large. Maximum size is 100KB. Please compress your image.' 
          });
        }
        user.bankQrCode = await compressAndConvertToDataUrl(bankQrCodeFile.buffer, bankQrCodeFile.mimetype);
      } catch (qrError) {
        console.error('Bank QR code processing error:', qrError);
        return res.status(400).json({ 
          success: false, 
          message: 'Error processing QR code: ' + (qrError.message || 'Unknown error') 
        });
      }
    }
    
    try {
    await user.save();
    res.json({ success: true, message: 'Profile updated successfully' });
    } catch (saveError) {
      console.error('User save error:', saveError);
      console.error('Save error stack:', saveError.stack);
      // Always return JSON - this fixes the JSON parsing error
      return res.status(500).json({ 
        success: false, 
        message: 'Error saving profile: ' + (saveError.message || 'Unknown error') 
      });
    }
  } catch (error) {
    console.error('Profile update error:', error);
    console.error('Error stack:', error.stack);
    
    // Handle specific error types
    if (error.name === 'MulterError') {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ 
          success: false, 
          message: 'File size too large. Maximum size is 100KB. Please compress your images.' 
        });
      }
      return res.status(400).json({ 
        success: false, 
        message: 'File upload error: ' + error.message 
      });
    }
    
    // Always return JSON, never HTML - this fixes the JSON parsing error
    return res.status(500).json({ 
      success: false, 
      message: 'Error updating profile: ' + (error.message || 'Unknown error') 
    });
  }
});

// Add or update a link
router.post('/link', auth, upload.fields([{ name: 'customIcon', maxCount: 1 }, { name: 'menuCardImage', maxCount: 3 }]), handleMulterError, async (req, res) => {
  try {
    let { category, url, displayName, categoryType, linkId, order, menuType, menuItems, showDisplayName } = req.body;
    
    // For menu, products, services, and custom (with images/items), URL and displayName are optional
    // For other categories, URL is required
    const isCustomWithMenu = categoryType === 'custom' && menuType && (menuType === 'images' || menuType === 'items');
    if (category !== 'menu' && category !== 'products' && category !== 'services' && !isCustomWithMenu) {
      if (!url) {
        return res.status(400).json({ success: false, message: 'URL is required' });
      }
      
      // If showDisplayName is true, displayName must be provided
      const shouldShowDisplayName = showDisplayName === 'true' || showDisplayName === true;
      if (shouldShowDisplayName && (!displayName || displayName.trim() === '')) {
        return res.status(400).json({ success: false, message: 'Display name is required when "Show display name" is checked' });
      }
      
      // If displayName is empty and showDisplayName is false, set empty string
      if (!displayName) {
        displayName = '';
      }
    }
    
    // Set defaults for menu category if not provided
    if (category === 'menu') {
      url = url || '#';
      displayName = displayName || 'Menu';
      menuType = menuType || 'images'; // Default to images if not specified
    }
    
    // Set defaults for products category if not provided
    if (category === 'products') {
      url = url || '#';
      displayName = displayName || 'Products';
      menuType = menuType || 'items'; // Products always use items (no image option)
    }
    
    // Set defaults for services category if not provided
    if (category === 'services') {
      url = url || '#';
      displayName = displayName || 'Services';
      menuType = menuType || 'items'; // Services always use items (no image option)
    }
    
    // Set defaults for custom category if not provided
    if (categoryType === 'custom') {
      menuType = menuType || 'url'; // Default to 'url' if not specified
      if (menuType === 'url') {
        // For URL type, URL is required
        if (!url) {
          return res.status(400).json({ success: false, message: 'URL is required for custom link' });
        }
      } else {
        // For images/items type, URL is optional (can be '#')
        url = url || '#';
      }
      displayName = displayName || 'Custom';
    }
    
    // For payment category, set default display name and handle URL
    if (category === 'payment' && categoryType === 'default') {
      // Set default display name for payment (cannot be changed by user)
      displayName = 'Bharathpe/CRED';
      // Set showDisplayName to true by default for payment
      if (showDisplayName === undefined || showDisplayName === '') {
        showDisplayName = 'true';
      }
      const user = await User.findById(req.user._id);
      if (user) {
        // Check if URL is just UPI ID or incomplete
        const upiId = user.upiId || '';
        const payeeName = user.upiPayeeName || user.businessName || user.name || 'Merchant';
        
        // If URL doesn't start with upi://, assume it's just UPI ID or needs generation
        if (!url.toLowerCase().startsWith('upi://') && !url.toLowerCase().startsWith('upiqr://')) {
          if (upiId) {
            // Generate full UPI link from profile - NO amount parameter (am) to allow any amount
            const encodedPayeeName = encodeURIComponent(payeeName);
            url = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodedPayeeName}&cu=INR`;
            
            // Add aid (App ID) if available - REMOVES ₹2000 LIMIT
            if (user.upiAid && user.upiAid.trim() !== '') {
              url += `&aid=${encodeURIComponent(user.upiAid)}`;
            }
          } else {
            return res.status(400).json({ 
              success: false, 
              message: 'Please set your UPI ID in Business Profile first, or enter a complete UPI payment URL' 
            });
          }
        } else if (url.toLowerCase().startsWith('upi://') || url.toLowerCase().startsWith('upiqr://')) {
          // URL is already a UPI link
          // Remove any amount (am) parameter to ensure no amount limits
          url = url.replace(/[&?]am=[^&]*/gi, '');
          
          // Add aid (App ID) if available and not already present - REMOVES ₹2000 LIMIT
          if (user.upiAid && user.upiAid.trim() !== '' && !url.includes('aid=')) {
            url += (url.includes('?') ? '&' : '?') + `aid=${encodeURIComponent(user.upiAid)}`;
          }
          
          url = url.trim();
        }
      }
    } else {
      // Save URL as-is for non-payment links
      url = url.trim();
    }

    let icon = '';
    if (categoryType === 'custom') {
      const customIconFile = req.files && req.files['customIcon'] ? req.files['customIcon'][0] : null;
      if (customIconFile) {
        // Store custom icon as base64 data URL
        // Multer already enforces 100KB limit, so just convert
        icon = bufferToDataUrl(customIconFile.buffer, customIconFile.mimetype);
      } else if (linkId) {
        // If updating and no new file, keep existing icon
        const existingLink = await Link.findById(linkId);
        if (existingLink) {
          icon = existingLink.icon;
        } else {
          return res.status(400).json({ success: false, message: 'Custom category requires icon upload' });
        }
      } else {
        return res.status(400).json({ success: false, message: 'Custom category requires icon upload' });
      }
    } else if (categoryType === 'default' && DEFAULT_CATEGORIES[category]) {
      // For payment category, use UPI logo URL
      if (category === 'payment' && DEFAULT_CATEGORIES[category].isImage) {
        icon = DEFAULT_CATEGORIES[category].icon; // This is the UPI logo URL
      } else {
        icon = DEFAULT_CATEGORIES[category].icon;
      }
    } else {
      return res.status(400).json({ success: false, message: 'Invalid category or icon' });
    }

    // Handle menu card images upload (for menu category and custom images type) - up to 3 images
    // Products category only supports items (no images)
    let menuCardImages = [];
    let parsedMenuItems = [];
    
    // Handle custom category with images/items types
    if (categoryType === 'custom' && menuType && (menuType === 'images' || menuType === 'items')) {
      if (menuType === 'images') {
        // Handle custom images upload
        const menuCardFiles = req.files && req.files['menuCardImage'] ? req.files['menuCardImage'] : [];
        const filesToProcess = menuCardFiles.slice(0, 3);
        
        if (filesToProcess.length > 0) {
          for (const menuCardFile of filesToProcess) {
            try {
              if (menuCardFile.size > 100 * 1024) {
                console.warn('Custom card file size exceeds limit:', menuCardFile.size);
                return res.status(400).json({ 
                  success: false, 
                  message: 'Image is too large. Maximum size is 100KB per image. Please compress your images.' 
                });
              }
              const imageDataUrl = await compressAndConvertToDataUrl(menuCardFile.buffer, menuCardFile.mimetype);
              menuCardImages.push(imageDataUrl);
            } catch (menuError) {
              console.error('Custom card processing error:', menuError);
              return res.status(400).json({ 
                success: false, 
                message: 'Error processing image: ' + (menuError.message || 'Unknown error') 
              });
            }
          }
        } else if (linkId) {
          // If updating and no new files, keep existing images
          const existingLink = await Link.findById(linkId);
          if (existingLink) {
            menuCardImages = existingLink.menuCardImages || [];
          }
        }
      } else if (menuType === 'items') {
        // Handle custom items
        try {
          if (menuItems && typeof menuItems === 'string') {
            parsedMenuItems = JSON.parse(menuItems);
          } else if (Array.isArray(menuItems)) {
            parsedMenuItems = menuItems;
          }
          
          // Validate menu items structure
          if (parsedMenuItems && parsedMenuItems.length > 0) {
            for (const category of parsedMenuItems) {
              if (!category.categoryName || !category.items || !Array.isArray(category.items)) {
                return res.status(400).json({ 
                  success: false, 
                  message: 'Invalid items structure. Each category must have a name and items array.' 
                });
              }
              for (const item of category.items) {
                if (!item.name || item.price === undefined || item.price === null) {
                  return res.status(400).json({ 
                    success: false, 
                    message: 'Each item must have a name and price.' 
                  });
                }
                item.price = parseFloat(item.price);
                if (isNaN(item.price) || item.price < 0) {
                  return res.status(400).json({ 
                    success: false, 
                    message: 'Item price must be a valid positive number.' 
                  });
                }
              }
            }
          }
        } catch (parseError) {
          console.error('Custom items parse error:', parseError);
          return res.status(400).json({ 
            success: false, 
            message: 'Error parsing items: ' + (parseError.message || 'Invalid format') 
          });
        }
        
        // If updating and no new items provided, keep existing
        if (linkId && (!parsedMenuItems || parsedMenuItems.length === 0)) {
          const existingLink = await Link.findById(linkId);
          if (existingLink) {
            parsedMenuItems = existingLink.menuItems || [];
          }
        }
      }
    }
    
    if (category === 'menu' || category === 'bar' || category === 'products' || category === 'services') {
      // Bar, products and services categories only support items, not images
      if (category === 'bar' || category === 'products' || category === 'services') {
        menuType = 'items'; // Force items for bar, products and services
      }
      
      if (menuType === 'images' && category === 'menu') {
        // Handle image uploads
        const menuCardFiles = req.files && req.files['menuCardImage'] ? req.files['menuCardImage'] : [];
        
        // Limit to 3 images
        const filesToProcess = menuCardFiles.slice(0, 3);
        
        if (filesToProcess.length > 0) {
          for (const menuCardFile of filesToProcess) {
            try {
              // Check file size before processing
              if (menuCardFile.size > 100 * 1024) {
                console.warn('Menu card file size exceeds limit:', menuCardFile.size);
                return res.status(400).json({ 
                  success: false, 
                  message: 'Menu card image is too large. Maximum size is 100KB per image. Please compress your images.' 
                });
              }
              const imageDataUrl = await compressAndConvertToDataUrl(menuCardFile.buffer, menuCardFile.mimetype);
              menuCardImages.push(imageDataUrl);
            } catch (menuError) {
              console.error('Menu card processing error:', menuError);
              return res.status(400).json({ 
                success: false, 
                message: 'Error processing menu card: ' + (menuError.message || 'Unknown error') 
              });
            }
          }
        } else if (linkId) {
          // If updating and no new files, keep existing menu card images
          const existingLink = await Link.findById(linkId);
          if (existingLink) {
            menuCardImages = existingLink.menuCardImages || [];
          }
        }
      } else if (menuType === 'items') {
        // Handle menu items (categories with items and prices)
        try {
          if (menuItems && typeof menuItems === 'string') {
            parsedMenuItems = JSON.parse(menuItems);
          } else if (Array.isArray(menuItems)) {
            parsedMenuItems = menuItems;
          }
          
          // Validate menu items structure
          if (parsedMenuItems && parsedMenuItems.length > 0) {
            for (const category of parsedMenuItems) {
              if (!category.categoryName || !category.items || !Array.isArray(category.items)) {
                return res.status(400).json({ 
                  success: false, 
                  message: 'Invalid menu items structure. Each category must have a name and items array.' 
                });
              }
              for (const item of category.items) {
                if (!item.name || item.price === undefined || item.price === null) {
                  return res.status(400).json({ 
                    success: false, 
                    message: 'Each menu item must have a name and price.' 
                  });
                }
                // Ensure price is a number
                item.price = parseFloat(item.price);
                if (isNaN(item.price) || item.price < 0) {
                  return res.status(400).json({ 
                    success: false, 
                    message: 'Menu item price must be a valid positive number.' 
                  });
                }
              }
            }
          }
        } catch (parseError) {
          console.error('Menu items parse error:', parseError);
          return res.status(400).json({ 
            success: false, 
            message: 'Error parsing menu items: ' + (parseError.message || 'Invalid format') 
          });
        }
        
        // If updating and no new menu items provided, keep existing
        if (linkId && (!parsedMenuItems || parsedMenuItems.length === 0)) {
          const existingLink = await Link.findById(linkId);
          if (existingLink) {
            parsedMenuItems = existingLink.menuItems || [];
          }
        }
      }
    }

    if (linkId) {
      // Update existing link
      const link = await Link.findById(linkId);
      if (link && link.userId.toString() === req.user._id.toString()) {
        link.url = url;
        link.displayName = displayName;
        link.icon = icon;
        link.order = parseInt(order) || 0;
        // For payment category, always set showDisplayName to true
        if (category === 'payment') {
          link.showDisplayName = true;
        } else {
          link.showDisplayName = showDisplayName === 'true' || showDisplayName === true;
        }
        
        if (category === 'menu' || category === 'products' || category === 'services') {
          // Products and services always use items
          if (category === 'products' || category === 'services') {
            menuType = 'items';
          }
          link.menuType = menuType || (category === 'products' || category === 'services' ? 'items' : 'images');
          if (menuType === 'images' && category === 'menu') {
            if (menuCardImages.length > 0) {
              link.menuCardImages = menuCardImages;
            } else {
              // If no new images uploaded, keep existing images
              // (menuCardImages will be empty array if no new files)
              // Only clear if explicitly switching from items to images
              if (link.menuType === 'items') {
                link.menuCardImages = [];
              }
              // Otherwise, keep existing menuCardImages
            }
            link.menuItems = []; // Clear menu items when switching to images
          } else if (menuType === 'items') {
            link.menuItems = parsedMenuItems || [];
            link.menuCardImages = []; // Clear images when switching to items
          }
        } else if (categoryType === 'custom') {
          // Handle custom category with three types
          link.menuType = menuType || 'url';
          if (menuType === 'images') {
            if (menuCardImages.length > 0) {
              link.menuCardImages = menuCardImages;
            } else if (linkId) {
              // If updating and no new images, keep existing
              const existingLink = await Link.findById(linkId);
              if (existingLink && existingLink.menuType === 'images') {
                link.menuCardImages = existingLink.menuCardImages || [];
              } else {
                link.menuCardImages = [];
              }
            } else {
              link.menuCardImages = [];
            }
            link.menuItems = [];
          } else if (menuType === 'items') {
            link.menuItems = parsedMenuItems || [];
            link.menuCardImages = [];
          } else {
            // URL type - no menu data
            link.menuCardImages = [];
            link.menuItems = [];
          }
        } else {
          // Clear menu-related fields for non-menu categories
          link.menuCardImages = [];
          link.menuItems = [];
          link.menuType = 'images';
        }
        
        await link.save();
        return res.json({ success: true, message: 'Link updated successfully', link });
      }
      return res.status(404).json({ success: false, message: 'Link not found' });
    } else {
      // Create new link
      const linkData = {
        userId: req.user._id,
        category: category || 'custom',
        categoryType: categoryType || 'default',
        url,
        icon,
        displayName,
        order: parseInt(order) || 0,
        // For payment category, always set showDisplayName to true
        showDisplayName: category === 'payment' ? true : (showDisplayName === 'true' || showDisplayName === true)
      };
      
      if (category === 'menu' || category === 'products' || category === 'services') {
        // Products and services always use items
        if (category === 'products' || category === 'services') {
          menuType = 'items';
        }
        linkData.menuType = menuType || (category === 'products' || category === 'services' ? 'items' : 'images');
        if (menuType === 'items') {
          linkData.menuItems = parsedMenuItems || [];
          linkData.menuCardImages = [];
        } else {
          linkData.menuCardImages = menuCardImages || [];
          linkData.menuItems = [];
        }
      } else if (categoryType === 'custom') {
        // Handle custom category with three types
        linkData.menuType = menuType || 'url';
        if (menuType === 'images') {
          linkData.menuCardImages = menuCardImages || [];
          linkData.menuItems = [];
        } else if (menuType === 'items') {
          linkData.menuItems = parsedMenuItems || [];
          linkData.menuCardImages = [];
        } else {
          // URL type - no menu data
          linkData.menuCardImages = [];
          linkData.menuItems = [];
        }
      } else {
        linkData.menuCardImages = [];
        linkData.menuItems = [];
        linkData.menuType = 'images';
      }
      
      const link = new Link(linkData);
      await link.save();
      return res.json({ success: true, message: 'Link added successfully', link });
    }
  } catch (error) {
    console.error('Link save error:', error);
    res.status(500).json({ success: false, message: 'Error saving link: ' + error.message });
  }
});

// Delete a link (soft delete - sets isActive to false)
router.delete('/link/:id', auth, async (req, res) => {
  try {
    const link = await Link.findById(req.params.id);
    if (link && link.userId.toString() === req.user._id.toString()) {
      // Soft delete: set isActive to false (preserves data for analytics)
      link.isActive = false;
      await link.save();
      return res.json({ success: true, message: 'Link deleted successfully' });
    }
    return res.status(404).json({ success: false, message: 'Link not found' });
  } catch (error) {
    console.error('Link delete error:', error);
    res.status(500).json({ success: false, message: 'Error deleting link' });
  }
});

// Get user's public page data
router.get('/preview', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const links = await Link.find({ userId: req.user._id, isActive: true }).sort({ order: 1 });
    
    res.json({ user, links });
  } catch (error) {
    console.error('Preview error:', error);
    res.status(500).json({ success: false, message: 'Error loading preview' });
  }
});

module.exports = router;

