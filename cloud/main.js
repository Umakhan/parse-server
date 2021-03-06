console.log('Cloud code connected');

const Mailgun = require('mailgun-js');

const configs = require('../index.js');
const config = configs.parseConfig;
const mailgunConfig = configs.mailgunConfig;
const SITE = configs['URL_SITE'];


let mailgun = new Mailgun(mailgunConfig);


const ROLE_ADMIN = "ADMIN";
const ROLE_EDITOR = "EDITOR";


let promisify = pp => {
  return new Promise((rs, rj) => pp.then(rs, rj));
};

let promisifyW = pp => {
  return new Promise((rs, rj) => pp.then(rs, rs));
};

let checkRights = (user, obj) => {
  let acl = obj.getACL();
  if (!acl)
    return true;
  
  let read = acl.getReadAccess(user.id);
  let write = acl.getWriteAccess(user.id);
  
  let pRead = acl.getPublicReadAccess();
  let pWrite = acl.getPublicWriteAccess();
  
  return read && write || pRead && pWrite;
};

let getAllObjects = query => {
  const MAX_COUNT = 50;
  let objects = [];
  
  let getObjects = (offset = 0) => {
    return promisify(query
      .limit(MAX_COUNT)
      .skip(offset)
      .find({useMasterKey: true})
    )
      .then(res => {
        if (!res.length)
          return objects;
        
        objects = objects.concat(res);
        return getObjects(offset + MAX_COUNT);
      })
  };
  
  return getObjects();
};


let getTableData = table => {
  let endpoint = '/schemas/' + table;
  
  return new Promise((resolve, reject) => {
    Parse.Cloud.httpRequest({
      url: config.serverURL + endpoint,
      method: 'GET',
      mode: 'cors',
      cache: 'no-cache',
      headers: {
        'Content-Type': 'application/json',
        'X-Parse-Application-Id': config.appId,
        'X-Parse-Master-Key': config.masterKey
      }
    })
      .then(response => {
        if (response.status == 200)
          resolve(response.data);
        else
          resolve(null);
      }, () => resolve(null));
  });
};

let setTableData = (table, data, method = 'POST') => {
  let endpoint = '/schemas/' + table;
  
  return new Promise((resolve, reject) => {
    Parse.Cloud.httpRequest({
      url: config.serverURL + endpoint,
      method,
      mode: 'cors',
      cache: 'no-cache',
      headers: {
        'Content-Type': 'application/json',
        'X-Parse-Application-Id': config.appId,
        'X-Parse-Master-Key': config.masterKey
      },
      body: JSON.stringify(data)
    })
      .then(response => {
        if (response.status == 200)
          resolve();
        else
          reject();
      }, reject);
  });
};

let deleteTable = table => {
  let endpoint = '/schemas/' + table;
  
  return new Promise((resolve, reject) => {
    Parse.Cloud.httpRequest({
      url: config.serverURL + endpoint,
      method: 'DELETE',
      mode: 'cors',
      cache: 'no-cache',
      headers: {
        'Content-Type': 'application/json',
        'X-Parse-Application-Id': config.appId,
        'X-Parse-Master-Key': config.masterKey
      }
    })
      .then(response => {
        if (response.status == 200)
          resolve();
        else
          reject();
      }, reject);
  });
};

let deleteContentItem = (user, tableName, itemId) => {
  let item;
  
  return promisify(
    new Parse.Query(tableName)
      .get(itemId, {useMasterKey: true})
  )
    .then(p_item => {
      item = p_item;
      
      if (!checkRights(user, item))
        return Promise.reject("Access denied!");
      
      return getTableData(tableName);
    })
    
    .then(data => {
      for (let field in data.fields) {
        let val = data.fields[field];
        if (val.type == 'Pointer' && val.targetClass == 'MediaItem') {
          let media = item.get(field);
          //!! uncontrolled async operation
          if (media)
            media.destroy({useMasterKey: true});
        }
      }
    })
    
    .then(() => promisify(item.destroy({useMasterKey: true})));
};

let deleteModel = (user, model) => {
  if (!checkRights(user, model))
    return Promise.reject("Access denied!");
  
  let tableName;
  
  return getAllObjects(
    new Parse.Query('ModelField')
      .equalTo('model', model)
  )
    .then(fields => {
      let promises = [];
      for (let field of fields) {
        if (checkRights(user, field))
          promises.push(promisifyW(field.destroy({useMasterKey: true})));
      }
    
      return Promise.all(promises);
    })
    
    .catch(() => Promise.resolve())
  
    .then(() => {
      tableName = model.get('tableName');
      return getAllObjects(
        new Parse.Query(tableName));
    })
  
    .then(items => {
      let promises = [];
      for (let item of items) {
        promises.push(
          promisifyW(
            deleteContentItem(user, tableName, item.id)
          ));
      }
    
      return Promise.all(promises);
    })
  
    .catch(() => Promise.resolve())
  
    .then(() => deleteTable(tableName))
  
    .catch(() => Promise.resolve())
  
    .then(() => promisify(model.destroy({useMasterKey: true})));
};


Parse.Cloud.define("deleteContentItem", (request, response) => {
  if (!request.user) {
    response.error("Must be signed in to call this Cloud Function.");
    return;
  }
  
  deleteContentItem(
    request.user,
    request.params.tableName,
    request.params.itemId
  )
    .then(() => response.success("Successfully deleted content item."))
    .catch(error => response.error("Could not delete content item: " + JSON.stringify(error, null, 2)));
});

Parse.Cloud.define("deleteModel", (request, response) => {
  if (!request.user) {
    response.error("Must be signed in to call this Cloud Function.");
    return;
  }
  
  promisify(
    new Parse.Query("Model")
      .get(request.params.modelId, {useMasterKey: true})
  )
    .then(model => deleteModel(request.user, model))
    
    .then(() => response.success("Successfully deleted model."))
  
    .catch(error => response.error("Could not delete model: " + JSON.stringify(error, null, 2)));
});

Parse.Cloud.define("deleteSite", (request, response) => {
  if (!request.user) {
    response.error("Must be signed in to call this Cloud Function.");
    return;
  }
  
  let site;
  
  promisify(
    new Parse.Query("Site")
      .get(request.params.siteId, {useMasterKey: true})
  )
    .then(p_site => {
      site = p_site;
      
      if (!checkRights(request.user, site))
        return Promise.reject("Access denied!");
      
      return getAllObjects(
        new Parse.Query('Model')
          .equalTo('site', site));
    })
    
    .then(models => {
      let promises = [];
      for (let model of models)
        promises.push(promisifyW(
          deleteModel(request.user, model)
        ));
      
      return promises;
    })
    
    .then(() => {
      return getAllObjects(
        new Parse.Query('Collaboration')
          .equalTo('site', site));
    })
  
    .then(collabs => {
      let promises = [];
      for (let collab of collabs) {
        if (checkRights(request.user, collab))
          promises.push(promisifyW(collab.destroy({useMasterKey: true})));
      }
  
      return Promise.all(promises);
    })
  
    //.catch(() => Promise.resolve())
    
    .then(() => promisify(site.destroy({useMasterKey: true})))
  
    .then(() => response.success("Successfully deleted site."))
  
    .catch(error => response.error("Could not delete site: " + JSON.stringify(error, null, 2)));
});


let onCollaborationModify = (collab, deleting = false) => {
  let site = collab.get('site');
  let user = collab.get('user');
  let role = collab.get('role');
  
  let owner, collabACL;
  
  
  return promisify(site.fetch({useMasterKey: true}))
    
    .then(() => {
      //ACL for collaborations
      owner = site.get('owner');
      
      collabACL = collab.getACL();
      if (!collabACL)
        collabACL = new Parse.ACL(owner);
      
      //getting all site collabs
      return getAllObjects(
        new Parse.Query('Collaboration')
          .equalTo('site', site));
    })
    
    .then(collabs => {
      if (!user)
        return;
      
      for (let tempCollab of collabs) {
        //set ACL for others collab
        let tempCollabACL = tempCollab.getACL();
        if (!tempCollabACL)
          tempCollabACL = new Parse.ACL(owner);
        
        if (collab.get('email') == user.get('email'))
          continue;
        
        tempCollabACL.setReadAccess(user, !deleting && role == ROLE_ADMIN);
        tempCollabACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);
        
        tempCollab.setACL(tempCollabACL);
        //!! uncontrolled async operation
        tempCollab.save(null, {useMasterKey: true});
        
        //set ACL for current collab
        if (!deleting) {
          let tempRole = tempCollab.get('role');
          let tempUser = tempCollab.get('user');
          collabACL.setReadAccess(tempUser, tempRole == ROLE_ADMIN);
          collabACL.setWriteAccess(tempUser, tempRole == ROLE_ADMIN);
        }
      }
      
      collabACL.setReadAccess(user, true);
      collabACL.setWriteAccess(user, true);
      collab.setACL(collabACL);
      //!! uncontrolled async operation
      collab.save(null, {useMasterKey: true});
    })
    
    .then(() => {
      if (!user)
        return;
      
      //ACL for site
      let siteACL = site.getACL();
      if (!siteACL)
        siteACL = new Parse.ACL(owner);
      
      siteACL.setReadAccess(user, !deleting);
      siteACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);
      site.setACL(siteACL);
      //!! uncontrolled async operation
      site.save(null, {useMasterKey: true});
  
      //ACL for media items
      return getAllObjects(
        new Parse.Query('MediaItem')
          .equalTo('site', site));
    })
  
    .then(mediaItems => {
      if (!user)
        return;
  
      for (let item of mediaItems) {
        let itemACL = item.getACL();
        if (!itemACL)
          itemACL = new Parse.ACL(owner);
  
        itemACL.setReadAccess(user, !deleting);
        itemACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);
        item.setACL(itemACL);
        //!! uncontrolled async operation
        item.save(null, {useMasterKey: true});
      }
      
      //ACL for models and content items
      return getAllObjects(
        new Parse.Query('Model')
          .equalTo('site', site));
    })
    
    .then(models => {
      if (!user)
        return;
      
      for (let model of models) {
        let modelACL = model.getACL();
        if (!modelACL)
          modelACL = new Parse.ACL(owner);
        
        modelACL.setReadAccess(user, !deleting);
        modelACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);
        model.setACL(modelACL);
        //!! uncontrolled async operation
        model.save(null, {useMasterKey: true});
        
        let tableName = model.get('tableName');
        //!! uncontrolled async operation
        getTableData(tableName)
          .then(response => {
            let CLP = response.classLevelPermissions;
            if (!CLP)
              CLP = {
                'get': {},
                'find': {},
                'create': {},
                'update': {},
                'delete': {},
                'addField': {}
              };
            
            if (!deleting) {
              CLP['get'][user.id] = true;
              CLP['find'][user.id] = true;
            } else {
              if (CLP['get'].hasOwnProperty(user.id))
                delete CLP['get'][user.id];
              if (CLP['find'].hasOwnProperty(user.id))
                delete CLP['find'][user.id];
            }
            
            if (!deleting && (role == ROLE_ADMIN || role == ROLE_EDITOR)) {
              CLP['create'][user.id] = true;
              CLP['update'][user.id] = true;
              CLP['delete'][user.id] = true;
            } else {
              if (CLP['create'].hasOwnProperty(user.id))
                delete CLP['create'][user.id];
              if (CLP['update'].hasOwnProperty(user.id))
                delete CLP['update'][user.id];
              if (CLP['delete'].hasOwnProperty(user.id))
                delete CLP['delete'][user.id];
            }
            
            if (!deleting && role == ROLE_ADMIN)
              CLP['addField'][user.id] = true;
            else if (CLP['addField'].hasOwnProperty(user.id))
              delete CLP['addField'][user.id];
            
            //!! uncontrolled async operation
            let data = {"classLevelPermissions": CLP};
            setTableData(tableName, data)
              .catch(() => setTableData(tableName, data, 'PUT'));
          });
      }
  
      return getAllObjects(
        new Parse.Query('ModelField')
          .containedIn('model', models));
    })
    
    .then(fields => {
      for (let field of fields) {
        let fieldACL = field.getACL();
        if (!fieldACL)
          fieldACL = new Parse.ACL(owner);
  
        fieldACL.setReadAccess(user, !deleting);
        fieldACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);
        field.setACL(fieldACL);
        //!! uncontrolled async operation
        field.save(null, {useMasterKey: true});
      }
    });
};


Parse.Cloud.define("onCollaborationModify", (request, response) => {
  if (!request.user) {
    response.error('You must be authorized!');
    return;
  }
   
  promisify(
    new Parse.Query("Collaboration")
      .get(request.params.collabId, {useMasterKey: true})
  )
    .then(collab => {
      if (!checkRights(request.user, collab))
        return Promise.reject("Access denied!");
      
      return onCollaborationModify(collab, request.params.deleting);
    })
    
    .then(() => response.success('ACL setup ends!'))
    
    .catch(response.error);
});

Parse.Cloud.afterSave(Parse.User, (request, response) => {
  let user = request.object;
  
  new Parse.Query('Collaboration')
    .equalTo('email', user.get('email'))
    
    .find({useMasterKey: true})
    
    .then(p_collabs => {
      let promises = [];
      for (let collab of p_collabs) {
        if (collab.get('user'))
          return Promise.reject('user also exists!');
  
        collab.set('user', user);
        
        promises.push(
          promisify(collab.save(null, {useMasterKey: true}))
            .then(() => onCollaborationModify(collab))
        );
      }
      return Promise.all(promises);
    })
    
    .then(response.success)
    
    .catch(response.success);
});

Parse.Cloud.define("onModelAdd", (request, response) => {
  if (!request.user) {
    response.error('You must be authorized!');
    return;
  }
  
  let model, site, owner, modelACL;
  
  promisify(
    new Parse.Query("Model")
      .get(request.params.modelId, {useMasterKey: true})
  )
    .then(p_model => {
      model = p_model;
      
      site = model.get('site');
      return promisify(site.fetch({useMasterKey: true}));
    })
    
    .then(() => {
      //ACL for collaborations
      owner = site.get('owner');
      modelACL = new Parse.ACL(owner);
      
      return getAllObjects(
        new Parse.Query('Collaboration')
          .equalTo('site', site));
    })
    
    .then(collabs => {
      let admins = [owner.id];
      let writers = [owner.id];
      let all = [owner.id];
      
      for (let collab of collabs) {
        let user = collab.get('user');
        let role = collab.get('role');
  
        modelACL.setReadAccess(user, true);
        modelACL.setWriteAccess(user, role == ROLE_ADMIN);
  
        if (role == ROLE_ADMIN)
          admins.push(user.id);
        if (role == ROLE_ADMIN || role == ROLE_EDITOR)
          writers.push(user.id);
        all.push(user.id);
      }
  
      model.setACL(modelACL);
      //!! uncontrolled async operation
      model.save(null, {useMasterKey: true});
      
      //set CLP for content table
      let CLP = {
        'get': {},
        'find': {},
        'create': {},
        'update': {},
        'delete': {},
        'addField': {},
        /*
        "readUserFields": [
          "owner"
        ],
        "writeUserFields": [
          "owner"
        ]
        */
      };
      
      for (let user of all) {
        CLP['get'][user] = true;
        CLP['find'][user] = true;
      }
      for (let user of writers) {
        CLP['create'][user] = true;
        CLP['update'][user] = true;
        CLP['delete'][user] = true;
      }
      for (let user of admins) {
        CLP['addField'][user] = true;
      }
  
      let data = {"classLevelPermissions": CLP};
      return setTableData(model.get('tableName'), data);
    })
    
    .then(() => response.success('ACL setup ends!'))
    
    .catch(response.error);
});

Parse.Cloud.define("onFieldAdd", (request, response) => {
  if (!request.user) {
    response.error('You must be authorized!');
    return;
  }
  
  let field, model, site, owner, fieldACL;
  
  promisify(
    new Parse.Query("ModelField")
      .get(request.params.fieldId, {useMasterKey: true})
  )
    .then(p_field => {
      field = p_field;
  
      model = field.get('model');
      return promisify(model.fetch({useMasterKey: true}));
    })
    .then(() => {
      site = model.get('site');
      return promisify(site.fetch({useMasterKey: true}));
    })
    .then(() => {
      //ACL for collaborations
      owner = site.get('owner');
      fieldACL = new Parse.ACL(owner);
    
      return getAllObjects(
        new Parse.Query('Collaboration')
          .equalTo('site', site));
    })
    .then(collabs => {
      for (let collab of collabs) {
        let user = collab.get('user');
        let role = collab.get('role');
  
        fieldACL.setReadAccess(user, true);
        fieldACL.setWriteAccess(user, role == ROLE_ADMIN);
      }
    
      field.setACL(fieldACL);
      //!! uncontrolled async operation
      field.save(null, {useMasterKey: true});
    })
  
    .then(() => response.success('ACL setup ends!'))
  
    .catch(response.error);
});

Parse.Cloud.define("onContentModify", (request, response) => {
  if (!request.user) {
    response.error('You must be authorized!');
    return;
  }

  let url = request.params.URL;
  
  if (!url) {
    response.success('Warning! There is no content hook!');
    return;
  }
  
  Parse.Cloud.httpRequest({
    url,
    method: 'GET'
  })
    .then(response => {
      if (response.status == 200)
        response.success(response.data);
      else
        response.error(response.status);
    }, response.error);
});


Parse.Cloud.define("onMediaItemAdd", (request, response) => {
  if (!request.user) {
    response.error('You must be authorized!');
    return;
  }
  
  let item, site, itemACL;
  
  promisify(
    new Parse.Query("MediaItem")
      .get(request.params.itemId, {useMasterKey: true})
  )
    .then(p_item => {
      item = p_item;
      
      site = item.get('site');
      return promisify(site.fetch({useMasterKey: true}));
    })
    
    .then(() => {
      //ACL for collaborations
      let owner = site.get('owner');
      itemACL = new Parse.ACL(owner);
      
      return getAllObjects(
        new Parse.Query('Collaboration')
          .equalTo('site', site));
    })
    
    .then(collabs => {
      for (let collab of collabs) {
        let user = collab.get('user');
        let role = collab.get('role');
  
        itemACL.setReadAccess(user, true);
        itemACL.setWriteAccess(user, role == ROLE_ADMIN);
      }
  
      item.setACL(itemACL);
      //!! uncontrolled async operation
      item.save(null, {useMasterKey: true});
    })
    
    .then(() => response.success('ACL setup ends!'))
    
    .catch(response.error);
});


Parse.Cloud.define("inviteUser", function(request, response) {
  if (!request.user) {
    response.error('You must be authorized!');
    return;
  }
  
  let emailSelf = request.user.get('email');
  let email = request.params.email;
  let siteName = request.params.siteName;
  if (!email || !siteName) {
    response.error('Email or siteName is empty!');
    return;
  }
  
  let link = `${SITE}/sign?mode=register&email=${email}`;
  
  console.log(`Send invite to ${email} ${new Date()}`);
  
  const {AppCache} = require('parse-server/lib/cache');
  const MailgunAdapter = AppCache.get(config.appId)['userController']['adapter'];
  
  MailgunAdapter.send({
    templateName: 'inviteEmail',
    recipient: email,
    variables: {siteName, emailSelf, link}
  })
    .then(() => {
      console.log(`Invite sent to ${email} ${new Date()}`);
      response.success("Invite email sent!");
    })
    .catch (error => {
      console.log("got an error in inviteUser: " + error);
      response.error(error);
    });
});

Parse.Cloud.define("sendEmail", function(request, response) {
  console.log("sendEmail " + new Date());
  
  let data = {
    from:     mailgunConfig.fromAddress,
    to:       request.params.address,
    subject:  request.params.subject,
    html:     request.params.body
  };
  
  mailgun.messages().send(data, error => {
    if (error) {
      console.log("got an error in sendEmail: " + error);
      response.error(error);
    }	else {
      console.log("email sent to " + toEmail + " " + new Date());
      response.success("Email sent!");
    }
  });
});


Parse.Cloud.define("checkPassword", (request, response) => {
  if (!request.user) {
    response.error('You must be authorized!');
    return;
  }
  
  let username = request.user.get('username');
  let password = request.params.password;
  
  Parse.User.logIn(username, password)
    .then(response.success, response.error);
});