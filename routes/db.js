"use strict";

const ObjectId = require('mongodb').ObjectID;
const merge = require('merge-descriptors');
const sanitize = require('../modules/sanitize');


class EMongo {
	constructor(req) {
		Object.defineProperties(this, {
			req: {value: req},
			mng: {value: req.mongoMng}
		});

		this.useMobile = req.useMobile;
		this.view = 'results';
		this.locals = req.res.locals;

		merge(this.locals, {
			title: 'EucaMongo',
			action: req.params.action || req.query.action || 'find',
			op: req.params.op || req.query.op,
			byid: req.query.byid,
			distinct: req.query.distinct,
			err: req.params.err,
			scripts: []
		});

		if (this.locals.collection) {
			this.collection = req.collection;
			this.locals.scripts.push('/js/search-string.js');
		} else if (!this.locals.collection && !this.locals.op && !this.useMobile)
			this.locals.op = 'stats';

		this.dbname = this.locals.dbname;

		this.db = req.db;
	}

	process(next) {
		const req = this.req;

		switch (this.locals.action) {
			case 'explain':
				let query = this.getQuery();

				if (!query)
					return req.res.json({error: 'Invalid query'});

				this.collection.find(query).explain(function (err, r) {
					req.res.json(err || r);
				});
				break;
			case 'remove':
				if (req.query.criteria) {
					query = this.getQuery();
					this.locals.criteria = req.query.criteria;

					if (!query)
						return next.call(this, new Error('Invalid query'));

					this.getCollections(() => {
						this.collection.remove(query, (err, r) => {
							if (err)
								return next.call(this, err);

							this.locals.message = r.n + ' records affected';

							next.call(this);
						});
					});
				}
				break;

			case 'update':
				this.getCollections(function () {
					this.doUpdate(next);
				});
				break;

			case 'distinct':
				this.getCollections(function () {
					this.distinct(next);
				});
				break;

			case 'findById':
			case 'find':
			default:
				this.getCollections(() => {
					if (!this.locals.collection) {
						if (!this.useMobile)
							return this.dbStats(next);

						this.view = 'collections';

						return next.call(this);
					}

					if (this.locals.op)
						return this.colStats(next);

					this.processCollection(next);
				});
		}
	}

	distinct(next) {
		const distinct = this.locals.distinct.trim();

		if (!distinct)
			return next.call(this);

		const $match = {$match: this.getQuery()};
		const $group = {$group: {_id: "$" + distinct, count: {$sum: 1}}};

		this.collection.aggregate([$match, $group])
			.toArray()
			.then(r => {
				if (!r.length)
					this.locals.message = this.locals.ml.noRecordsFound;
				else {
					r.forEach(o => {
						o.val = JSON.stringify(o._id);
						o.criteria = '{"' + distinct + '":' + o.val + '}';
					});

					r.sort((a, b) => {
						return b.count - a.count;
					});

					this.locals.distinctResult = r;
					this.locals.count = r.length;
					this.locals.message = this.locals.ml.results.replace('%d', r.length);
				}

				next.call(this);
			})
			.catch(next);
	}

	dbStats(next) {
		const req = this.req;

		switch (this.locals.op) {
			case 'stats':
				this.view = 'dbstats';

				this.db.stats((err, stats) => {
					if(stats.ok === 1)
						stats.ok = "✓";

					this.locals.dbStats = sanitize.obj(stats);

					next.call(this);
				});
				break;

			case 'processlist':
				this.view = 'processlistdb';

				req.mongoMng.currentOp({ns: new RegExp('^' + this.locals.dbname + '.')})
					.then(data => {
						this.locals.processlist = data.inprog;

						next.call(this);
					})
					.catch(err => next.call(this, err));
				break;

			case 'newcollection':
				this.view = 'newcollection';
				next.call(this);
				break;

			case 'command':
				this.view = 'dbcommand';
				next.call(this);
				break;

			case 'export':
				this.view = 'export';
				this.locals.selected = req.query.collections;
				this.locals.scripts.push('/js/export.js');
				next.call(this);
				break;

			case 'import':
				this.view = 'import';
				this.locals.msg = req.query.msg;
				next.call(this);
				break;

			case 'repair':
				this.view = 'repair';
				next.call(this);
				break;

			case 'auth':
				this.view = 'dbauth';
				this.locals.scripts.push('/js/auth.js');

				//admin db
				req.mongoMng.db.collection('system.users').find({db: this.locals.dbname}, (err, users) => {
					if (err)
						return next.call(this, err);

					this.locals.users = [];

					users.each((err, user) => {
						if (err || !user)
							return next.call(this);

						this.locals.users.push(user);
					});
				});
				break;

			case 'add-user':
				this.view = 'adduser';
				this.locals.err = req.query.err;
				this.locals.username = req.query.username;

				next.call(this);
				break;

			case 'dup':
				this.view = 'dupdb';
				this.locals.err = req.query.err;
				this.locals.name = req.query.name;
				next.call(this);
				break;

			default:
				req.res.status(404).send('op ' + this.locals.op + ' not defined');
		}
	}

	colStats(next) {
		const req = this.req;

		switch (this.locals.op) {
			case 'stats':
				this.view = 'colstats';
				this.collection.stats((err, stats) => {
					this.locals.stats = stats;

					this.mng.admin().command({top: 1}, (err, top) => {
						if (err)
							return next.call(this, err);

						this.locals.top = top.totals[this.db.databaseName + '.' + this.collection.collectionName];

						next.call(this);
					});
				});
				break;
			case 'validate':
				this.view = 'validate';
				this.db.command({validate: this.collection.collectionName, full: true}, (err, validate) => {
					if (err)
						return next.call(this, err);

					this.locals.validate = validate;
					next.call(this);
				});
				break;
			case 'indexes':
				this.view = 'indexes';

				this.collection.indexes((err, r) => {
					if (err)
						return next.call(this, err);

					this.locals.indexes = r;

					if (!this.locals.scripts)
						this.locals.scripts = [];

					this.locals.scripts.push('/js/indexes.js');

					next.call(this);
				});

				break;
			case 'create-index':
				this.view = 'create-index';
				this.locals.scripts.push('/js/create-index.js');
				next.call(this);
				break;
			case 'rename':
				this.view = 'rename';
				next.call(this);
				break;
			case 'dup':
				this.view = 'dupcollection';
				this.locals.err = req.query.err;
				next.call(this);
				break;
			case 'insert':
				this.view = 'insert';
				this.locals.json = req.query.json || "{\n\n\n\n\n\n\n\n\n\n\n}";

				const msg = req.query.msg;

				switch (msg) {
					case 'parseError':
						this.locals.msg = 'Invalid json';
						break;
					case 'ok':
						this.locals.msg = 'Object successfully inserted';
						break;
					default:
						this.locals.msg = msg;
				}

				next.call(this);
				break;
			case 'import':
				this.view = 'import';
				next.call(this);
				break;
			case 'error':
				this.view = 'collerror';
				this.locals.message = req.params.msg;
				next.call(this);
				break;
			default:
				next();
//			req.res.status(404).send('op ' + this.locals.op + ' not defined');
		}
	}

	getCollections(next) {
		this.locals.collections = [];

		this.mng.getCollections(this.dbname, (err, collections) => {
			if (err || !collections)
				return next.call(this, err, collections);

			this.locals.collections = collections;

			next.call(this);
		});
	}

	getQuery() {
		let query;

		this.locals.criteria = this.req.query.criteria || '{\n\t\n}';

		if (this.locals.action === "findById")
			return {_id: ObjectId(this.locals.byid)};

		if (!this.req.query.criteria)
			return {};

		try {
			eval('query=' + this.req.query.criteria.replace(/[\t\n\r]/g, ''));

			//noinspection JSUnusedAssignment
			return query;
		} catch (e) {
			return e;
		}
	}

	getUpdateOperators() {
		this.locals.update = this.req.query.update || "{\n\t'$set': {\n\t\t\n\t}\n}";

		if (!this.req.query.update)
			return;

		try {
			let ret;

			eval('ret=' + this.req.query.update.replace(/[\t\n\r]/g, ''));

			//noinspection JSUnresolvedVariable
			return ret;
		} catch (e) {
			return e;
		}
	}

	processCollection(next) {
		const req = this.req;
		const fields = this.queryFields(), sort = this.sortFields();

		this.getUpdateOperators();

		this.locals.page = req.query.page || 1;

		const query = this.getQuery();

		if (query instanceof Error)
			return next.call(this, query);

		if (!query)
			return next.call(this, new Error('Invalid query'));

		const page = parseInt(req.query.page) || 1;

		this.nativeFields(err => {
			if (err)
				return next.call(this, err);

			const cursor = this.collection.find(query, fields);

			cursor.count((err, count) => {
				if (err)
					return next.call(this, err);

				if (!count) {
					this.locals.message = this.locals.ml.noRecordsFound;

					return next.call(this);
				}

				const pagesCount = Math.floor(count / EMongo.limit) + 1;

				this.locals.url = req.url.replace(/[?&]page=\d*/, '');

				this.locals.paginator = {
					page: page,
					first: Math.max(1, page - 6),
					last: Math.min(pagesCount, page + 6),
					total: pagesCount,
					url: this.locals.url + (this.locals.url.indexOf('?') !== -1 ? '&' : '?') + 'page='
				};

				this.locals.count = count;
				this.locals.result = {};

				if (this.locals.action !== 'findById')
					this.locals.message = this.locals.ml.results.replace('%d', count);

				cursor
					.sort(sort)
					.limit(10)
					.skip((page - 1) * EMongo.limit)
					.each((err, r) => {
						if (err)
							return next.call(this, err);

						if (r)
							return this.locals.result[r._id] = sanitize.obj(r, '', null, true);

						next.call(this);
					});
			});
		});
	}

	doUpdate(next) {
		const req = this.req;

		let query = {};
		let update = this.getUpdateOperators();

		if (update instanceof Error) {
			update.message = 'Update conditions error: ' + update.message;

			return next.call(this, update);
		}

		if (!update)
			return next.call(this, new Error('Invalid update operators'));

		if (req.query.criteria) {
			query = this.getQuery();

			if (query instanceof Error)
				return next.call(this, query);

			if (!query)
				return next.call(this, new Error('Invalid query'));
		}

		this.collection.update(query, update, {multi: true}, (err, r) => {
			if (err)
				return next.call(this, err);

			if (r.result.ok)
				this.locals.message = req.res.locals.ml.rowsAffected + ': ' + r.result.nModified;

			this.queryFields();
			this.sortFields();

			this.nativeFields(err => next.call(this, err));
		});
	}

	queryFields() {
		const req = this.req;

		if (req.query.fields && typeof req.query.fields === 'string')
			req.query.fields = [req.query.fields];

		this.locals.fields = req.query.fields || [];

		return this.locals.fields;
	}

	sortFields() {
		const sort = this.req.query.sort || {_id: -1};

		this.locals.sortFields = new Array(4);

		let i = 0;

		for (let k in sort) {
			sort[k] = parseInt(sort[k]);
			this.locals.sortFields[i++] = {name: k, order: sort[k]};
		}

		return sort;
	}

	nativeFields(cb) {
		this.collection.findOne((err, doc) => {
			if (err || !doc)
				return cb(err);

			const fields = [];

			Object.keys(doc).forEach(k => fields.push(k));

			this.locals.nativeFields = fields;

			cb(null, fields);
		});
	}

	render() {
		let view = this.view;

		if (this.useMobile)
			view = 'mobile/' + view;

		this.req.res.render(view, this.locals);
	}
}

EMongo.limit = 10;

module.exports = function(req, res, next){
	new EMongo(req).process(function(err){
		if(err)
			res.locals.err = err.message;

		this ? this.render() : next();
	});
};

