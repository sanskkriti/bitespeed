require('dotenv').config();
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const app = express();
const prisma = new PrismaClient();

app.use(express.json());

/**
 * Endpoint /identify
 * Purpose Link and reconcile user contact details across multiple orders
 */
app.post('/identify', async (req, res) => {
  const { email, phoneNumber } = req.body;

  // Require at least one identifier
  if (!email && !phoneNumber) {
    return res.status(400).json({ error: "At least one of email or phoneNumber is required." });
  }

  try {
    // Step 1: Find all direct matches based on either email or phone
    const directMatches = await prisma.contact.findMany({
      where: {
        OR: [
          { email: email || undefined },
          { phoneNumber: phoneNumber || undefined }
        ]
      },
      orderBy: { createdAt: 'asc' }
    });

    // Step 2: Collect related contacts (including linked ones)
    let allRelated = [...directMatches];

    for (let contact of directMatches) {
      const linkedContacts = await prisma.contact.findMany({
        where: {
          OR: [
            { linkedId: contact.id },
            { id: contact.linkedId || 0 }
          ]
        }
      });
      allRelated.push(...linkedContacts);
    }

    // Remove duplicates by ID
    allRelated = Array.from(new Set(allRelated.map(c => c.id)))
                      .map(id => allRelated.find(c => c.id === id));

    // Step 3: Identify the primary contact (earliest created one)
    let primaryContact = allRelated.find(c => c.linkPrecedence === 'primary')
      || allRelated.reduce((a, b) => a.createdAt < b.createdAt ? a : b);

    // Step 4: Normalize others to link to primary
    for (let contact of allRelated) {
      if (contact.id !== primaryContact.id && contact.linkPrecedence !== 'secondary') {
        await prisma.contact.update({
          where: { id: contact.id },
          data: {
            linkPrecedence: 'secondary',
            linkedId: primaryContact.id,
            updatedAt: new Date()
          }
        });
      }
    }

    // Step 5: Check if the incoming request brings new info
    const alreadyExists = allRelated.some(c =>
      (!email || c.email === email) && (!phoneNumber || c.phoneNumber === phoneNumber)
    );

    if (!alreadyExists) {
      await prisma.contact.create({
        data: {
          email,
          phoneNumber,
          linkPrecedence: 'secondary',
          linkedId: primaryContact.id
        }
      });
    }

    // Step 6: Re-fetch full contact group after updates
    const finalContacts = await prisma.contact.findMany({
      where: {
        OR: [
          { id: primaryContact.id },
          { linkedId: primaryContact.id }
        ]
      }
    });

    // Step 7: Prepare the response
    const emails = [...new Set(finalContacts.map(c => c.email).filter(Boolean))];
    const phoneNumbers = [...new Set(finalContacts.map(c => c.phoneNumber).filter(Boolean))];
    const secondaryContactIds = finalContacts
      .filter(c => c.linkPrecedence === 'secondary')
      .map(c => c.id);

    return res.status(200).json({
      contact: {
        primaryContatctId: primaryContact.id, // Following the spec's typo intentionally
        emails: [primaryContact.email, ...emails.filter(e => e !== primaryContact.email)],
        phoneNumbers: [primaryContact.phoneNumber, ...phoneNumbers.filter(p => p !== primaryContact.phoneNumber)],
        secondaryContactIds
      }
    });

  } catch (err) {
    console.error('Error in /identify:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Server setup
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
