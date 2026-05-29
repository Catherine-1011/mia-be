const prisma = require('../config/prisma');
const { uploadToCloudinary } = require('../config/cloudinary');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const bcrypt = require('bcryptjs');

// Get profile for authenticated user (id from token)
exports.getProfile = async (request, reply) => {
  try {
    const userId = request.user?.userId || request.user?.uid || request.user?.id;
    if (!userId) {
      return reply.status(401).send({ message: 'Unauthorized - User ID not found in token' });
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        profileImage: true,
        role: true,
        isVerified: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true
      }
    });
    if (!user) {
      return reply.status(404).send({ message: 'User not found' });
    }
    reply.send(user);
  } catch (error) {
    reply.status(500).send({ message: 'Server error', error: error.message });
  }
};

// Update profile for authenticated user (id from token)
exports.updateProfile = async (request, reply) => {
  try {
    const userId = request.user?.userId || request.user?.uid || request.user?.id;
    
    if (!userId) {
      return reply.status(401).send({ 
        message: 'Unauthorized - User ID not found in token' 
      });
    }

    console.log('=== UPDATE PROFILE START ===');
    console.log('User ID:', userId);

    let name, phone, profileImageUrl;

    // Check if request is multipart
    const isMultipart = request.isMultipart();
    console.log('Is request multipart?', isMultipart);

    if (isMultipart) {
      // Process multipart form data using parts()
      const parts = request.parts();
    
    for await (const part of parts) {
      console.log('Processing part:', part.fieldname, 'Type:', part.type);
      
      if (part.type === 'file') {
        // Handle file upload
        console.log('File detected:', part.filename, 'Fieldname:', part.fieldname);
        
        // Only process if fieldname is 'profileImage'
        if (part.fieldname === 'profileImage') {
          try {
            // Ensure uploads directory exists
            const uploadsDir = path.join(__dirname, '../uploads/');
            if (!fs.existsSync(uploadsDir)) {
              fs.mkdirSync(uploadsDir, { recursive: true });
            }

            const tempPath = path.join(uploadsDir, `${Date.now()}_${part.filename}`);
            
            // Write file using stream
            await pipeline(part.file, fs.createWriteStream(tempPath));
            
            console.log('File saved to temp path:', tempPath);

            // Upload to Cloudinary
            const uploadResult = await uploadToCloudinary(tempPath, 'profile');
            profileImageUrl = uploadResult.url;
            
            console.log('✓ Cloudinary upload successful:', profileImageUrl);

            // Clean up temp file
            try {
              await fs.promises.unlink(tempPath);
              console.log('✓ Temp file cleaned up');
            } catch (unlinkError) {
              console.log('Warning: Could not delete temp file:', unlinkError.message);
            }
          } catch (uploadError) {
            console.error('✗ File upload error:', uploadError);
            return reply.status(500).send({
              message: 'Failed to upload profile image',
              error: uploadError.message
            });
          }
        }
      } else {
        // Handle regular fields
        if (part.fieldname === 'name') {
          name = part.value;
        } else if (part.fieldname === 'phone') {
          phone = part.value;
        }
        console.log('Field:', part.fieldname, '=', part.value);
      }
    }
    } else {
      // Handle JSON body for non-multipart requests
      console.log('Processing JSON body:', request.body);
      name = request.body?.name;
      phone = request.body?.phone;
      // Note: File upload not supported for JSON requests
      console.log('JSON request - no file upload support');
    }

    console.log('Extracted data:');
    console.log('- Name:', name);
    console.log('- Phone:', phone);
    console.log('- Profile Image URL:', profileImageUrl);

    // Build update data object
    const updateData = {};
    if (typeof name === 'string' && name.trim() !== '') {
      updateData.name = name.trim();
      console.log('Setting updateData.name =', updateData.name);
    } else {
      console.log('Name not set or empty:', name);
    }
    if (typeof phone === 'string' && phone.trim() !== '') {
      updateData.phone = phone.trim();
    }
    if (profileImageUrl !== undefined && profileImageUrl !== null) {
      updateData.profileImage = profileImageUrl;
    }

    console.log('Update data to be sent to database:', updateData);

    if (Object.keys(updateData).length === 0) {
      console.log('✗ No data to update');
      return reply.status(400).send({ 
        message: 'No data provided to update',
        debug: 'No valid fields or files were found in the request'
      });
    }

    // Update the user in database
    console.log('Updating user in database...');
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        profileImage: true,
        role: true,
        isVerified: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true
      }
    });

    console.log('✓ Database updated successfully');
    console.log('Updated user profileImage:', updatedUser.profileImage);
    console.log('=== UPDATE PROFILE END ===');

    reply.send({
      message: 'Profile updated successfully',
      user: updatedUser
    });

  } catch (error) {
    console.error('=== UPDATE PROFILE ERROR ===');
    console.error('Error:', error);
    console.error('Stack:', error.stack);
    
    reply.status(500).send({ 
      message: 'Server error', 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

// Change password for authenticated user
exports.changePassword = async (request, reply) => {
  try {
    const userId = request.user?.userId || request.user?.uid || request.user?.id;
    
    if (!userId) {
      return reply.status(401).send({ 
        message: 'Unauthorized - User ID not found in token' 
      });
    }

    const { currentPassword, newPassword } = request.body;

    if (!currentPassword || !newPassword) {
      return reply.status(400).send({
        message: 'Current password and new password are required'
      });
    }

    if (newPassword.length < 6) {
      return reply.status(400).send({
        message: 'New password must be at least 6 characters long'
      });
    }

    // Get current user
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      return reply.status(404).send({ message: 'User not found' });
    }

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);

    if (!isCurrentPasswordValid) {
      return reply.status(400).send({
        message: 'Current password is incorrect'
      });
    }

    // Hash new password
    const saltRounds = 12;
    const hashedNewPassword = await bcrypt.hash(newPassword, saltRounds);

    // Update password
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedNewPassword }
    });

    reply.send({
      message: 'Password changed successfully'
    });

  } catch (error) {
    console.error('Change password error:', error);
    reply.status(500).send({ 
      message: 'Server error', 
      error: error.message 
    });
  }
};

// ==================== SELLER PROFILE ====================

// Get full seller profile (seller token required)
exports.getSellerProfile = async (request, reply) => {
  try {
    const userId = request.user?.userId || request.user?.id;
    if (!userId) return reply.status(401).send({ success: false, message: 'Unauthorized' });

    const seller = await prisma.sellerProfile.findUnique({
      where: { userId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            phone: true,
            profileImage: true,
            role: true,
            emailVerified: true,
            createdAt: true
          }
        }
      }
    });

    if (!seller) {
      return reply.status(404).send({ success: false, message: 'Seller profile not found' });
    }

    return reply.send({ success: true, data: seller });
  } catch (error) {
    console.error('getSellerProfile error:', error);
    reply.status(500).send({ success: false, message: 'Server error', error: error.message });
  }
};

// Edit seller profile (seller token required)
// Editable fields: contactPerson, artistName, artistDescription,
//                  storeName, storeDescription, storeLogo (file or URL),
//                  storeBanner (file or URL), storeLocation, website
exports.updateSellerProfile = async (request, reply) => {
  try {
    const userId = request.user?.userId || request.user?.id;
    if (!userId) return reply.status(401).send({ success: false, message: 'Unauthorized' });

    const seller = await prisma.sellerProfile.findUnique({ where: { userId } });
    if (!seller) return reply.status(404).send({ success: false, message: 'Seller profile not found' });

    // Collect fields — support both multipart (with optional file) and JSON
    const fields = {};
    let storeLogoUrl, storeBannerUrl;

    if (request.isMultipart()) {
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          const uploadsDir = path.join(__dirname, '../uploads/');
          if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
          const tmpPath = path.join(uploadsDir, `${Date.now()}_${part.filename}`);
          await pipeline(part.file, fs.createWriteStream(tmpPath));

          if (part.fieldname === 'storeLogo') {
            const result = await uploadToCloudinary(tmpPath, 'store-logos');
            storeLogoUrl = result.url;
          } else if (part.fieldname === 'storeBanner') {
            const result = await uploadToCloudinary(tmpPath, 'store-banners');
            storeBannerUrl = result.url;
          }
          await fs.promises.unlink(tmpPath).catch(() => {});
        } else {
          fields[part.fieldname] = part.value;
        }
      }
    } else {
      Object.assign(fields, request.body || {});
    }

    const updateData = {};
    const textFields = [
      'contactPerson', 'artistName', 'artistDescription',
      'storeName', 'storeDescription', 'storeLocation', 'website'
    ];

    for (const f of textFields) {
      if (fields[f] !== undefined && fields[f] !== '') updateData[f] = fields[f];
    }

    // storeLogo / storeBanner can also come as plain URL strings in JSON
    if (storeLogoUrl) updateData.storeLogo = storeLogoUrl;
    else if (fields.storeLogo) updateData.storeLogo = fields.storeLogo;

    if (storeBannerUrl) updateData.storeBanner = storeBannerUrl;
    else if (fields.storeBanner) updateData.storeBanner = fields.storeBanner;

    if (Object.keys(updateData).length === 0) {
      return reply.status(400).send({ success: false, message: 'No valid fields provided to update' });
    }

    const updated = await prisma.sellerProfile.update({
      where: { userId },
      data: updateData
    });

    return reply.send({
      success: true,
      message: 'Seller profile updated successfully',
      data: updated
    });
  } catch (error) {
    console.error('updateSellerProfile error:', error);
    reply.status(500).send({ success: false, message: 'Server error', error: error.message });
  }
};
