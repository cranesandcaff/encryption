/* global EncryptionUtils:true */
/* global RSAKey:true */

EncryptionUtils = {
  docToUpdate: {},
  setKeypair: function (privateKey, publicKey) {
    var self = this;

    self.keyPairForNextEncryption = {
      privateKey: privateKey,
      publicKey: publicKey
    };
  },
  /*
   * encrypts certain fields of the given document
   * @param doc - the document to decrypt
   * @param fields - the fields of the document to be dercypted
   * @param name - the name of the principal that belongs to the document
   * @param asyncEncryption - use RSA if true, else use AES
   */
  encryptDocWithId: function (docId, fields, name, asyncEncryption) {
    var self = this;
    var asyncCrypto = asyncEncryption !== false;
    // client only so this works :)
    var user = Meteor.user();
    // get stored doc
    var doc = self.docToUpdate;
    // generate a id for the document in order to have one bevore inserting it
    doc._id = docId;

    // encrypt the message with the public key of the post principal
    var newDoc = {};
    _.each(fields, function (field) {
      newDoc[field] = self.encryptWithKey(doc[field], self.keyPairForNextEncryption.privateKey, asyncCrypto);
    });

    // get the principal of the user
    var userPrincipal = self.getPrincipal('user', user._id);
    if (!userPrincipal) {
      return;
    }
    // delete existing principal
    var existingPrincipal = Principals.findOne({
      dataType: name,
      dataId: doc._id
    });
    var shareWithUsers = [];
    if (existingPrincipal) {
      // find all users that had access to the encrypted data
      shareWithUsers = _.map(existingPrincipal.encryptedPrivateKeys, function(obj){
        return obj.userId;
      });
      // filter out the owner, so he does not get readded
      shareWithUsers = _.filter(shareWithUsers, function(userId) {
        return userId !== user._id;
      });
      // remove the old principal
      Principals.remove({_id: existingPrincipal._id});
    }
    // encrypt the private key with the users public key -- needs to be RSA
    var privateKey = self.encryptWithKey(self.keyPairForNextEncryption.privateKey, userPrincipal.publicKey, true);
    // create the principle in the database
    Principals.insert({
      dataType: name,
      dataId: doc._id,
      // TODO store public key if async encryption - not needed at the moment though
      // publicKey: self.keyPairForNextEncryption.publicKey,
      encryptedPrivateKeys: [{
        userId: user._id,
        key: privateKey
      }]
    });

    _.each(shareWithUsers, function(userId){
      self.shareDocWithUser(doc._id, name, userId);
    });
    return newDoc;
  },
  /*
   * decrypts certain fields of the given document
   * @param doc - the document to decrypt
   * @param fields - the fields of the document to be dercypted
   * @param name - the name of the principal that belongs to the document
   * @param asyncEncryption - use RSA if true, else use AES
   */
  decryptDoc: function (doc, fields, name, asyncEncryption) {
    var self = this;
    var asyncCrypto = asyncEncryption !== false;
    // get principal
    var principal = self.getPrincipal(name, doc._id);
    // return if the doc was not encrypted correctly
    if (!principal) {
      return doc;
    }
    // get decrypted private key of principal -- needs to be async
    var decryptedPrincipalPrivateKey = self.getPrivateKeyOfPrincipal(
      principal, true);
    // return if something went wrong
    if (!decryptedPrincipalPrivateKey) {
      return doc;
    }
    // decrypt each given field
    _.each(fields, function (field) {
      doc[field] = self.decryptWithKey(doc[field],
        decryptedPrincipalPrivateKey, asyncCrypto);
    });
    return doc;
  },
  /*
   * encrypts a given message with the given key using RSA or AES
   */
  encryptWithKey: function (message, key, async){
    var self = this;
    if(async) {
      return self._encryptWithRsaKey(message, key);
    } else {
      return self._encryptWithAesKey(message, key);
    }
  },
  // encrypts the given message with a key
  _encryptWithRsaKey: function (message, key) {
    var userKey = new RSA(key);
    return userKey.encrypt(message, 'base64');
  },
  _encryptWithAesKey: function (message, key) {
    var encryptedMessage = CryptoJS.AES.encrypt(message, key);
    return encryptedMessage.toString();
  },
  /*
   * decrypts a given message with the given key using RSA or AES
   */
  decryptWithKey: function (message, key, async){
    var self = this;
    if(async) {
      return self._decryptWithRsaKey(message, key);
    } else {
      return self._decryptWithAesKey(message, key);
    }
  },
  // decrypts the given message with a key
  _decryptWithRsaKey: function (message, key) {
    var postKey = new RSA(key);
    return postKey.decrypt(message, 'utf8');
  },
  _decryptWithAesKey: function (message, key) {
    var decryptedMessage = CryptoJS.AES.decrypt(message, key);
    return decryptedMessage.toString(CryptoJS.enc.Utf8);
  },
  /*
   * get private key of given principal
   * this method is the same for Principals using RSA
   * and for Principals using AES, since the key of the Principal gets
   * encrypted asynchronously anyway
   */
  getPrivateKeyOfPrincipal: function (principal, asyncCrypto) {

    // TODO add check
    // check(principal, Schema.Principal);
    if(!principal){
      return;
    }

    var self = this,
      useAsyncCrypto = asyncCrypto !== false,
      user = Meteor.user(),
      searchObj = {
        userId: user._id
      },
      privateKey = Session.get('privateKey'),
      encryptedKeys = _.where(principal.encryptedPrivateKeys, searchObj);

    if (!encryptedKeys.length) {
      return;
    }
    // return decrypted key
    return self.decryptWithKey(encryptedKeys[0].key, privateKey, useAsyncCrypto);
  },
  // search if a principal for the given params exists
  getPrincipal: function (type, id) {
    return Principals.findOne({
      dataType: type,
      dataId: id
    });
  },
  /*
   * shares the given doc with the given user
   * by encrypting the principal key of the doc with the publicKey of the user
   */
  shareDocWithUser: function (docId, docType, userId, asyncCrypto) {
    var self = this;
    var useAsyncCrypto = asyncCrypto !== false;
    // find principal of user to share post with
    var userPrincipal = self.getPrincipal('user', userId);
    if (!userPrincipal) {
      console.warn('no principal found for user with id: ' + userId);
      return;
    }

    // fint principal of post
    var principal = self.getPrincipal(docType, docId);
    if (!principal) {
      console.warn('no principal found for ' + docType + ' with id: ' +
        docId);
      return;
    }
    var principalKey = self.getPrivateKeyOfPrincipal(principal, useAsyncCrypto);

    var key = self._encryptWithRsaKey(principalKey, userPrincipal.publicKey);

    Principals.update({
      _id: principal._id
    }, {
      $push: {
        encryptedPrivateKeys: {
          userId: userId,
          key: key
        }
      }
    });
  },
  /*
   * extends the current user's profile with his (encrypted) privateKey
   * this key gets encrypted with his password via AES
   */
  extendProfile: function (password, callback) {
    var self = this;
    var userId = Meteor.userId();
    // generate keypair
    var key = new RSAKey();
    // generate a 1024 bit key async
    key.generateAsync(1024, "03", function () {
      // store the raw private key in the session
      Session.setAuth('privateKey', key.privatePEM());
      // encrypt the user's private key
      var privateKey = self._encryptWithAesKey(key.privatePEM(), password);

      Meteor.call('storeEncryptedPrivateKey', privateKey);
      // add a principal for the user
      Principals.insert({
        dataType: 'user',
        dataId: userId,
        publicKey: key.publicPEM()
      });

      callback();
    });

  },
  /*
   * decrypts the users privateKey with the given password via AES
   * @param password
   */
  onSignIn: function(password) {
    var self = this;
    var user = Meteor.user();
    var privateKey = self._decryptWithAesKey(user.profile.privateKey, password);
    Session.setAuth('privateKey', privateKey);
  }
};
