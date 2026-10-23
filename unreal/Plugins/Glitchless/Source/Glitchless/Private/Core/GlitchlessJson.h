// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

// The engine-independent core (everything under Core/) is plain C++17 with no Unreal types, so
// unreal/test builds and tests it with any compiler, without the engine. It never throws and
// needs no RTTI, as Unreal builds have neither.

#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <string>
#include <utility>
#include <vector>

namespace Glitchless
{
	/**
	 * A JSON value, the stuff events are made of. Objects keep their keys in the order they were
	 * set. Numbers read from JSON keep their text, so a saved event is sent byte for byte as it was
	 * written.
	 */
	class FValue
	{
	public:
		enum class EType : uint8_t
		{
			Null,
			Bool,
			Int,
			Double,
			String,
			Array,
			Object,
			Raw,
		};

		FValue() = default;
		FValue(std::nullptr_t) {}
		FValue(bool B) : Type(EType::Bool), BoolValue(B) {}
		FValue(int I) : Type(EType::Int), IntValue(I) {}
		FValue(long I) : Type(EType::Int), IntValue(I) {}
		FValue(long long I) : Type(EType::Int), IntValue(I) {}
		FValue(unsigned I) : Type(EType::Int), IntValue(I) {}
		FValue(unsigned long I) : Type(EType::Int), IntValue(static_cast<int64_t>(I)) {}
		FValue(unsigned long long I) : Type(EType::Int), IntValue(static_cast<int64_t>(I)) {}
		FValue(double D) : Type(EType::Double), DoubleValue(D) {}
		FValue(float D) : Type(EType::Double), DoubleValue(D) {}
		FValue(const char* S) : Type(EType::String), Text(S ? S : "") {}
		FValue(std::string S) : Type(EType::String), Text(std::move(S)) {}

		static FValue Array() { FValue V; V.Type = EType::Array; return V; }
		static FValue Object() { FValue V; V.Type = EType::Object; return V; }
		/** Text that is already JSON, written as it is. */
		static FValue Raw(std::string Json) { FValue V; V.Type = EType::Raw; V.Text = std::move(Json); return V; }
		static FValue List(std::initializer_list<FValue> Items);
		static FValue Strings(const std::vector<std::string>& Items);
		/** Null when the value is negative: "not measured". */
		static FValue OrNull(double V) { return V >= 0 ? FValue(V) : FValue(); }
		static FValue OrNull(int64_t V) { return V >= 0 ? FValue(V) : FValue(); }

		EType GetType() const { return Type; }
		bool IsNull() const { return Type == EType::Null; }
		bool IsNumber() const { return Type == EType::Int || Type == EType::Double; }
		bool IsString() const { return Type == EType::String; }
		bool IsArray() const { return Type == EType::Array; }
		bool IsObject() const { return Type == EType::Object; }

		bool AsBool() const { return Type == EType::Bool && BoolValue; }
		double AsNumber(double Fallback = 0) const;
		int64_t AsInt(int64_t Fallback = 0) const;
		const std::string& AsString() const { return Text; }

		// Arrays
		size_t Size() const { return Type == EType::Object ? Keys.size() : Items.size(); }
		const FValue& operator[](size_t I) const { return Items[I]; }
		FValue& operator[](size_t I) { return Items[I]; }
		void Push(FValue V);
		const std::vector<FValue>& GetItems() const { return Items; }

		// Objects
		/** The member called Key, or null when there is none. */
		const FValue* Find(const std::string& Key) const;
		FValue* Find(const std::string& Key);
		bool Has(const std::string& Key) const { return Find(Key) != nullptr; }
		/** Sets a member, keeping its place if it is already there. */
		FValue& Set(const std::string& Key, FValue V);
		const std::vector<std::string>& GetKeys() const { return Keys; }
		const FValue& ValueAt(size_t I) const { return Items[I]; }

		std::string Serialize() const;
		void Write(std::string& Out) const;
		/** Parses JSON text. False, and Out untouched, on anything that isn't JSON. */
		static bool Parse(const std::string& Json, FValue& Out);

		bool operator==(const FValue& Other) const;
		bool operator!=(const FValue& Other) const { return !(*this == Other); }

	private:
		friend class FJsonParser;

		EType Type = EType::Null;
		bool BoolValue = false;
		int64_t IntValue = 0;
		double DoubleValue = 0;
		std::string Text; // a string, raw JSON, or the text a parsed number was written as
		std::vector<std::string> Keys; // an object's keys; Items holds the values
		std::vector<FValue> Items;
	};

	namespace Json
	{
		/** A number the way JavaScript's JSON.stringify writes it, the shortest text that reads back the same. NaN and infinities are null. */
		void WriteNumber(std::string& Out, double D);
		void WriteString(std::string& Out, const std::string& S);
		/** Reads a JSON number's text, whatever the C locale's decimal point is. */
		double ReadNumber(const char* Begin, size_t Length);
		/** Not NaN or infinite, from the bits, so fast-math (MSVC's /fp:fast) can't assume it away. */
		bool IsFinite(double D);
	}
}
