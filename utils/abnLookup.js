const axios = require("axios");

// ABN lookup using Australian Business Register API
const abnLookup = async (abn) => {
  try {
    // Remove spaces and validate format
    const cleanABN = abn.replace(/\s/g, "");
    
    if (cleanABN.length !== 11) {
      return { isValid: false, message: "ABN must be 11 digits" };
    }

    if (!process.env.ABN_GUID) {
      throw new Error("ABN_GUID not configured in environment variables");
    }
      
      console.log("🔍 Validating ABN:", cleanABN);
      
      const response = await axios.get(
        `https://abr.business.gov.au/json/AbnDetails.aspx`,
        {
          params: { 
            abn: cleanABN,
            guid: process.env.ABN_GUID
          }
        }
      );

      // Parse JSONP response (ABR API returns callback(...) wrapper)
      let abrData;
      const responseText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
      
      // Extract JSON from callback wrapper: callback({...})
      const jsonMatch = responseText.match(/callback\((.*)\)$/);
      if (jsonMatch) {
        try {
          abrData = JSON.parse(jsonMatch[1]);
        } catch (e) {
          abrData = response.data;
        }
      } else {
        abrData = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      }

      // Log raw response for debugging
      console.log("📋 ABR API Response:", JSON.stringify(abrData, null, 2));

      // Check if ABN was found and is active
      const abnExists = abrData.Abn && abrData.Abn.toString().trim() === cleanABN;
      const isActive = abrData.AbnStatus === "Active";
      const isValid = !!(abnExists && isActive);

      console.log("✅ ABN Validation Result:", {
        abnExists,
        isActive,
        isValid,
        returnedABN: abrData.Abn,
        status: abrData.AbnStatus
      });

      // Determine message based on validation result
      let message = "";
      if (!abnExists) {
        message = "ABN not found in Australian Business Register";
      } else if (!isActive) {
        message = "ABN is not in Active status";
      } else {
        message = "Business verified successfully";
      }

      return {
        isValid: isValid ? true : false,
        message,
        data: {
          abn: cleanABN,
          entityName: abrData.EntityName || "",
          entityType: abrData.EntityTypeName || "",
          status: abrData.AbnStatus || "Not Found",
          gst: abrData.Gst || "Not Registered",
          businessName: abrData.BusinessName?.[0]?.OrganisationName || abrData.EntityName || "N/A",
          acn: abrData.Acn || "",
          address: {
            state: abrData.AddressState || "",
            postcode: abrData.AddressPostcode || ""
          }
        }
      };
  } catch (error) {
    console.error("ABN validation error:", error.response?.data || error.message);
    throw new Error(`ABN validation failed: ${error.message}`);
  }
};

module.exports = { abnLookup };

