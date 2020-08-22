const bcrypt = require('bcrypt');
const { nanoid } = require('nanoid');
const { isObjectIdValid, sendResponse, sendError } = require('../../utils');
const JWT = require('../../helpers/jwt');
const reservedUsernames = require('../../helpers/reservedUsernames');
const { verifyPushToken } = require('../../helpers/expoNotifications');
const { transporter } = require('../../mailer');
const User = require('./model');


const registerExpoToken = async (req, res) => {
  console.log('Registering Expo token!', req.body.token)
  if (!req.body.token) {
    return res.status(400).send(sendError(400, 'No token submitted'));
  }
  if (!verifyPushToken(req.body.token)) {
    return res.status(400).send(sendError(400, 'Token invalid'));
  }
  req.user.expoPushTokens.push(req.body.token);
  await req.user.save()
    .catch(error => {
      console.error(error);
      return res.status(500).send(sendError(500, 'Error saving push token to database'));
    })
  console.log('Registered!')
  return res.sendStatus(200);
}

const register = async (req, res) => {
  // Check if data has been submitted
  if (!req.body.email || !req.body.password || !req.body.username) {
    return res.status(406).send(sendError(406, 'Required fields (email, password, username) blank.'));
  }
  // Check if a user with this username already exists
  const existingUsername = await (User.findOne({ username: req.body.username }));
  if (existingUsername) {
    return res.status(403).send(sendError(403, 'Sorry, this username is unavailable.'));
  }
  // Check if this username is in the list of reserved usernames
  if (reservedUsernames.includes(req.body.username)) {
    return res.status(403).send(sendError(403, 'Sorry, this username is unavailable.'));
  }
  // Check if a user with this email already exists
  const existingEmail = await (User.findOne({ email: req.body.email }));
  if (existingEmail) {
    return res.status(403).send(sendError(403, 'An account with this email already exists. Is it yours?'));
  }
  const verificationToken = nanoid();
  const newUser = new User({
    email: req.body.email,
    password: await hashPassword(req.body.password),
    username: req.body.username,
    joined: new Date(),
    verificationToken: verificationToken,
    verificationTokenExpiry: Date.now() + 3600000 // 1 hour
  });
  const savedUser = await newUser.save();
  const sweetbotFollow = new Relationship({
    from: req.body.email,
    to: 'support@sweet.sh',
    toUser: '5c962bccf0b0d14286e99b68',
    fromUser: newUser._id,
    value: 'follow'
  });
  const savedFollow = await sweetbotFollow.save();
  const sentEmail = await transporter.sendMail({
    from: '"Sweet Support" <support@sweet.sh>',
    to: req.body.email,
    subject: "Sweet - New user verification",
    text: 'Hi! You are receiving this because you have created a new account on Sweet with this email.\n\n' +
    'Please click on the following link, or paste it into your browser, to verify your email:\n\n' +
    'https://sweet.sh/verify-email/' + verificationToken + '\n\n' +
    'If you did not create an account on Sweet, please ignore and delete this email. The token will expire in an hour.\n'
  });
  if (!savedUser || !savedFollow || !sentEmail) {
    return res.status(500).send(sendError(500, 'There has been a problem processing your registration.'));
  }
  return res.sendStatus(200);
}

const login = async (req, res) => {
  // Check if data has been submitted
  if (!req.body.email || !req.body.password) {
    // console.log("Login data missing")
    return res.status(401).send(sendError(401, 'User not authenticated'));
  }
  const user = await (User.findOne({ email: req.body.email }))
    .catch(error => {
      console.error(error);
      return res.status(401).send(sendError(401, 'User not authenticated'));
    });
  // If no user found
  if (!user) {
    // console.log("No user found")
    return res.status(401).send(sendError(401, 'User not authenticated'));
  }
  // console.log("Is verified:", user.isVerified)
  if (!user.isVerified) {
    // console.log("User not verified")
    return res.status(403).send(sendError(403, 'This account has not been verified.'));
  }
  // Compare submitted password to database hash
  bcrypt.compare(req.body.password, user.password, (err, result) => {
    if (!result) {
      // console.log("Password verification failed")
      return res.status(401).send(sendError(401, 'User not authenticated'));
    }
    const jwtOptions = {
      issuer: 'sweet.sh',
    }
    return res.status(200).send(sendResponse(JWT.sign({ id: user._id.toString() }, jwtOptions), 200));
  });
}

const listUsers = async (req, res) => {
  function c(e) {
    console.error('Error in user data builders');
    console.error(e);
    return res.status(500).send(sendError(500, 'Error fetching users'));
  }
  let sortOrder;
  switch (req.params.sortorder) {
    case 'asc_username':
      sortOrder = '-username';
      break;
    case 'desc_username':
      sortOrder = 'username';
      break;
    case 'desc_updated':
      sortOrder = '-lastUpdated';
      break;
    case 'asc_updated':
      sortOrder = 'lastUpdated';
      break;
    default:
      sortOrder = '-username';
      break;
  }
  const myRelationships = (await Relationship.find({ fromUser: req.user._id, value: { $in: ['follow', 'trust'] } }).catch(c)).map(v => v.toUser)
  const myUsers = (await User.find({ _id: { $in: myRelationships } }, 'email username imageEnabled image displayName aboutParsed aboutRaw location pronouns websiteParsed websiteRaw').sort(sortOrder).catch(c))
  return res.status(200).send(sendResponse(myUsers, 200))
}

const detailUser = async (req, res) => {
  function c(e) {
    console.error('Error in user data builders');
    console.error(e);
    return res.status(500).send(sendError(500, 'Error in user data builders'));
  }
  // req.params.identifier might be a username OR a MongoDB _id string. We need to work
  // out which it is:
  let userQuery;
  if (isObjectIdValid(req.params.identifier)) {
    userQuery = { _id: req.params.identifier };
  } else {
    userQuery = { username: req.params.identifier };
  }

  const profileData = await User.findOne(userQuery, 'email username imageEnabled image displayName aboutParsed aboutRaw location pronouns websiteParsed websiteRaw settings acceptedCodeOfConduct')
    .catch(err => {
      return res.status(500).send(sendError(500, 'Error fetching user'));
    });
  if (!profileData) {
    return res.status(404).send(sendError(404, 'User not found'));
  }
  const communitiesData = await Community.find({ members: profileData._id }, 'name slug url descriptionRaw descriptionParsed rulesRaw rulesParsed image imageEnabled membersCount').catch(c); // given to the renderer at the end
  const followersArray = (await Relationship.find({ to: profileData.email, value: 'follow' }, { from: 1 }).catch(c)).map(v => v.from); // only used for the below
  const followers = await User.find({ email: { $in: followersArray } }, 'email username imageEnabled image displayName aboutParsed aboutRaw location pronouns websiteParsed websiteRaw').catch(c); // passed directly to the renderer
  const theirFollowedUserEmails = (await Relationship.find({ from: profileData.email, value: 'follow' }, { to: 1 }).catch(c)).map(v => v.to); // used in the below and to see if the profile user follows you
  const theirFollowedUserData = await User.find({ email: { $in: theirFollowedUserEmails } }, 'email username imageEnabled image displayName aboutParsed aboutRaw location pronouns websiteParsed websiteRaw'); // passed directly to the renderer
  const usersWhoTrustThemArray = (await Relationship.find({ to: profileData.email, value: 'trust' }).catch(c)).map(v => v.from); // only used for the below
  const usersWhoTrustThem = await User.find({ email: { $in: usersWhoTrustThemArray } }, 'email username imageEnabled image displayName aboutParsed aboutRaw location pronouns websiteParsed websiteRaw').catch(c); // passed directly to the renderer
  const theirTrustedUserEmails = (await Relationship.find({ from: profileData.email, value: 'trust' }).catch(c)).map(v => v.to); // used to see if the profile user trusts the logged in user (if not isOwnProfile) and the below
  const theirTrustedUserData = await User.find({ email: { $in: theirTrustedUserEmails } }, 'email username imageEnabled image displayName aboutParsed aboutRaw location pronouns websiteParsed websiteRaw').catch(c); // given directly to the renderer

  let userFollowsYou = false;
  let userTrustsYou = false;
  let isOwnProfile;
  let flagsFromTrustedUsers;
  let flagged;
  let trusted;
  let followed;
  let muted;
  let myFlaggedUserData;
  let mutualTrusts;
  let mutualFollows;
  let mutualCommunities;
  // Is this the logged in user's own profile?
  if (profileData.email === req.user.email) {
    isOwnProfile = true;
    userTrustsYou = false;
    userFollowsYou = false;
    trusted = false;
    followed = false;
    muted = false;
    flagged = false;
    flagsFromTrustedUsers = 0;
    const myFlaggedUserEmails = (await Relationship.find({ from: req.user.email, value: 'flag' }).catch(c)).map(v => v.to); // only used in the below line
    myFlaggedUserData = await User.find({ email: { $in: myFlaggedUserEmails } }, 'email username imageEnabled image displayName aboutParsed aboutRaw location pronouns websiteParsed websiteRaw settings').catch(c); // passed directly to the renderer, but only actually used if isOwnProfile, so we're only actually defining it in here
  } else {
    isOwnProfile = false;

    const myTrustedUserEmails = (await Relationship.find({ from: req.user.email, value: 'trust' }).catch(c)).map(v => v.to); // used for flag checking and to see if the logged in user trusts this user
    const myFollowedUserEmails = (await Relationship.find({ from: req.user.email, value: 'follow' }).catch(c)).map(v => v.to); // Used for mutual follows notification
    const myCommunities = await Community.find({ members: req.user._id }).catch(c); // Used for mutual communities notification

    // Check if profile user and logged in user have mutual trusts, follows, and communities
    mutualTrusts = usersWhoTrustThemArray.filter(v => myTrustedUserEmails.includes(v));
    mutualFollows = followersArray.filter(v => myFollowedUserEmails.includes(v));
    mutualCommunities = communitiesData.filter(community1 => myCommunities.some(community2 => community1._id.equals(community2._id))).map(community => community._id);

    // Check if profile user follows and/or trusts logged in user
    userTrustsYou = theirTrustedUserEmails.includes(req.user.email); // not sure if these includes are faster than an indexed query of the relationships collection would be
    userFollowsYou = theirFollowedUserEmails.includes(req.user.email);

    // Check if logged in user follows and/or trusts and/or has muted profile user
    trusted = myTrustedUserEmails.includes(profileData.email);
    followed = !!(await Relationship.findOne({ from: req.user.email, to: profileData.email, value: 'follow' }).catch(c));
    muted = !!(await Relationship.findOne({ from: req.user.email, to: profileData.email, value: 'mute' }).catch(c));

    const flagsOnUser = await Relationship.find({ to: profileData.email, value: 'flag' }).catch(c);
    flagsFromTrustedUsers = 0;
    flagged = false;
    for (const flag of flagsOnUser) {
      // Check if logged in user has flagged profile user
      if (flag.from === req.user.email) {
        flagged = true;
      }
      // Check if any of the logged in user's trusted users have flagged profile user
      if (myTrustedUserEmails.includes(flag.from)) {
        flagsFromTrustedUsers++;
      }
    }
  }
  const response = {
    loggedIn: req.user ? true : false,
    isOwnProfile,
    profileData,
    trusted,
    flagged,
    muted,
    followed,
    followersData: followers,
    usersWhoTrustThemData: usersWhoTrustThem,
    userFollowsYou,
    userTrustsYou,
    trustedUserData: theirTrustedUserData,
    followedUserData: theirFollowedUserData,
    communitiesData,
    flaggedUserData: myFlaggedUserData,
    flagsFromTrustedUsers,
    mutualTrusts,
    mutualFollows,
    mutualCommunities,
  };
  return res.status(200).send(sendResponse(response, 200));
}

const changeSettings = async (req, res) => {
  const newSettings = req.body;
  if (!newSettings) {
    return res.status(406).send(sendError(406, 'No new settings provided'));
  }
  req.user.settings = { ...req.user.settings, ...req.body }
  req.user.save()
    .then(user => {
      return res.status(200).send(sendResponse(user, 200))
    })
    .catch(error => {
      console.log(error);
      return res.status(500).send(sendError(500, 'Error saving new settings'));
    })
}

const reportUser = async (req, res) => {
  const reportedPost = await Post.findById(req.body.postid);
  if (!reportedPost) {
    return res.status(404).send(sendError(404, 'Post not found.'));
  }
  const sentEmail = await transporter.sendMail({
    from: '"Sweet Support" <support@sweet.sh>',
    to: '"Sweet Support" <support@sweet.sh>',
    subject: "Sweet - Post report",
    text: 'Post ID:' + reportedPost._id
  });
  return res.sendStatus(200);
}

const getCoC = async (req, res) => {
  if (req.user.acceptedCodeOfConduct) {
    return res.status(200).send(sendResponse({acceptanceStatus: true}, 200));
  } else {
    const codeOfConductText = '<p><strong>Sweet is dedicated to providing a harassment-free experience for everyone. We do not tolerate harassment of participants in any form.</strong></p><p><strong>You must read and accept this code of conduct to use the Sweet app and website.</strong></p><p>This code of conduct applies to all Sweet spaces, including public channels, private channels and direct messages, both online and off. Anyone who violates this code of conduct may be sanctioned or expelled from these spaces at the discretion of the administrators.</p><p>Members under 18 are allowed, but are asked to stay out of channels with adult imagery.</p><p>Some Sweet spaces, such as Communities, may have additional rules in place, which will be made clearly available to participants. Participants are responsible for knowing and abiding by these rules. This code of conduct holds priority in any disputes over rulings.</p><h4 id="types-of-harassment">Types of Harassment</h4><ul> <li>Offensive comments related to gender, gender identity and expression, sexual orientation, disability, mental illness, neuro(a)typicality, physical appearance, body size, race, immigration status, religion, or other identity marker. This includes anti-Indigenous/Nativeness and anti-Blackness.</li> <li>Unwelcome comments regarding a person’s lifestyle choices and practices, including those related to food, health, parenting, drugs, and employment.</li> <li>Deliberate misgendering or use of “dead” or rejected names</li> <li>Gratuitous or off-topic sexual images or behaviour in spaces where they’re not appropriate</li> <li>Physical contact and simulated physical contact (eg, textual descriptions like “hug” or “backrub”) without consent or after a request to stop.</li> <li>Threats of violence Incitement of violence towards any individual, including encouraging a person to commit suicide or to engage in self-harm</li> <li>Deliberate intimidation</li> <li>Stalking or following</li> <li>Harassing photography or recording, including logging online activity for harassment purposes</li> <li>Sustained disruption of discussion</li> <li>Unwelcome sexual attention</li> <li>Patterns of inappropriate social contact, such as requesting/assuming inappropriate levels of intimacy with others</li> <li>Continued one-on-one communication after requests to cease</li> <li>Deliberate “outing” of any aspect of a person’s identity without their consent except as necessary to protect vulnerable people from intentional abuse</li> <li>Publication of non-harassing private communication</li> <li>Microaggressions, which take the form of everyday jokes, put downs, and insults, that spread humiliating feelings to people of marginalized groups</li></ul><p>Jokes that resemble the above, such as “hipster racism”, still count as harassment even if meant satirically or ironically.</p><p>Sweet prioritizes marginalized people’s safety over privileged people’s comfort. The administrators will not act on complaints regarding:</p><ul> <li>“Reverse”-isms, including “reverse racism,” “reverse sexism,” and “cisphobia”</li> <li>Reasonable communication of boundaries, such as “leave me alone,” “go away,” or “I’m not discussing this with you.”</li> <li>Communicating in a “tone” you don’t find congenial</li> <li>Criticism of racist, sexist, cissexist, or otherwise oppressive behavior or assumptions.</li></ul><h4 id="reporting">Reporting</h4><p>If you are being harassed by a member of Sweet, notice that someone else is being harassed, or have any other concerns, please <strong>report the harassing content using the menu visible at the bottom of the post or comment</strong>. If the person being reported is an administrator, they will recuse themselves from handling your incident.</p><p>The administrators reserve the right to exclude people from Sweet based on their past behavior, including behavior outside Sweet spaces and behavior towards people who are not on Sweet. We will not name harassment victims without their affirmative consent.</p><p>Remember that you are able to flag people on Sweet, which is an anonymous way to make others aware of a person’s behaviour, but is not designed as a replacement for reporting.</p><h4 id="consequences">Consequences</h4><p>Participants asked to stop any harassing behavior are expected to comply immediately. If a participant engages in harassing behavior, the administrators may take any action they deem appropriate, up to and including expulsion from all Sweet spaces and identification of the participant as a harasser to other Sweet members or the general public.</p>'
    return res.status(200).send(sendResponse({acceptanceStatus: false, codeOfConductText: codeOfConductText}, 200));
  }
}

const acceptCoC = async (req, res) => {
  req.user.acceptedCodeOfConduct = true;
  await req.user.save();
  return res.sendStatus(200);
}


module.exports = {
  acceptCoC,
  changeSettings,
  detailUser,
  getCoC,
  listUsers,
  login,
  register,
  registerExpoToken,
  reportUser,
};